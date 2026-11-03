import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { audit, syncAll } from '../lib/database.js';
import { DIWALI_SIGNUP_CUTOFF, DIWALI_BONUS_CAP, diwaliTasks } from '../lib/diwali-2026.js';

const action = 'event.diwali_2026_rescheduled';
const legacyTitles = ['Appreciate a colleague', 'Share a positive experience', 'Join the Diwali quiz',
  'Dress in ethnic wear', 'Join a team activity', 'Share an engagement idea'];

export async function updateDiwali2026(pool, eventIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const eventId of [...new Set(eventIds)].sort((a, b) => a - b)) {
      const { rows: [event] } = await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [eventId]);
      if (!event) throw new Error(`Event ${eventId} not found.`);
      const alreadyUpdated = await client.query('SELECT id FROM audit_log WHERE event_id=$1 AND action=$2', [event.id, action]);
      if (alreadyUpdated.rows.length) { results.push({ eventId, alreadyUpdated: true }); continue; }
      if ((!event.is_demo && event.title !== 'CSI Solution 2026 Lucky Draw') ||
          (event.is_demo && event.title !== 'DEMO ONLY - Reusable 15-Employee Showcase')) {
        throw new Error(`Event ${eventId} is not one of the expected Diwali events.`);
      }
      if (event.status === 'ended') throw new Error(`Event ${eventId} has ended; its archive must not be changed.`);
      const activeDraw = await client.query('SELECT id FROM draws WHERE event_id=$1 AND reveal_at>clock_timestamp() LIMIT 1', [event.id]);
      if (activeDraw.rows.length) throw new Error(`Wait for event ${eventId} to finish revealing winners.`);
      const { rows: tasks } = await client.query('SELECT * FROM tasks WHERE event_id=$1 ORDER BY id', [event.id]);
      if (tasks.length !== 6 || tasks.some((task, index) => task.title !== legacyTitles[index])) {
        throw new Error(`Event ${eventId} has a different task set; review it before migrating.`);
      }
      const completions = (await client.query('SELECT c.* FROM completions c JOIN people p ON p.id=c.person_id WHERE p.event_id=$1', [event.id])).rows;
      const tickets = (await client.query('SELECT t.* FROM tickets t JOIN people p ON p.id=t.person_id WHERE p.event_id=$1', [event.id])).rows;
      await audit(client, event.id, action, { previousEvent: event, previousTasks: tasks, previousCompletions: completions,
        previousTickets: tickets, reason: 'Celebration moved to 5 November; four bonus activities; quiz/game requires a win. Old quiz participation must be verified again as a win.' });
      for (const [index, [title, description]] of diwaliTasks.entries()) {
        await client.query('UPDATE tasks SET title=$2,description=$3,reward=1,active=TRUE WHERE id=$1', [tasks[index].id, title, description]);
      }
      await client.query('UPDATE completions SET done=FALSE WHERE task_id=$1', [tasks[2].id]);
      await client.query('UPDATE tasks SET active=FALSE WHERE event_id=$1 AND id=ANY($2::int[])',
        [event.id, tasks.slice(4).map(task => task.id)]);
      const title = event.is_demo ? 'DEMO ONLY - Reusable 15-Employee Showcase - 5 November 2026' :
        'CSI Solution Diwali Celebration - 5 November 2026';
      await client.query('UPDATE events SET title=$2,signup_closes_at=$3,bonus_cap=$4 WHERE id=$1',
        [event.id, title, DIWALI_SIGNUP_CUTOFF, DIWALI_BONUS_CAP]);
      await syncAll(client, { ...event, bonus_cap: DIWALI_BONUS_CAP });
      results.push({ eventId, updated: true, quizWinsNeedVerification: true });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('Use --apply to confirm updates to the real event (1) and reusable demo (3).');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({ connectionString: url.toString() });
  try { console.log(JSON.stringify(await updateDiwali2026(pool, [1, 3]))); }
  finally { await pool.end(); }
}
