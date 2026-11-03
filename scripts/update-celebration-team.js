import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { audit, withEvent } from '../lib/database.js';

export async function updateCelebrationTeam(pool, eventId = 1) {
  return withEvent(pool, eventId, async (client, event) => {
    if (!event.title.includes('5 November 2026') || event.is_demo) throw new Error('Expected the main November 5 celebration.');
    const { rows: tasks } = await client.query('SELECT * FROM tasks WHERE event_id=$1 ORDER BY id', [event.id]);
    const replace = value => value.replace(/\b(?:Your|your) (?:Project Manager \(PM\)|PM\b)/g, 'The Diwali Celebration Team')
      .replace(/\bProject Managers?(?: \(PMs?\))?|\bPMs?\b/g, 'Diwali Celebration Team');
    const changes = [];
    for (const task of tasks) {
      const title = replace(task.title);
      const description = replace(task.description);
      if (title === task.title && description === task.description) continue;
      await client.query('UPDATE tasks SET title=$2,description=$3 WHERE id=$1', [task.id, title, description]);
      changes.push({ taskId: task.id, previousTitle: task.title, previousDescription: task.description, title, description });
    }
    if (changes.length) await audit(client, event.id, 'event.celebration_team_wording_updated', { changes });
    return { eventId, updatedTasks: changes.length };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('Use --apply to update the main event activity wording only.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = url.hostname.replace('-pooler.', '.');
  url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({ connectionString: url.toString() });
  try { console.log(JSON.stringify(await updateCelebrationTeam(pool))); }
  finally { await pool.end(); }
}
