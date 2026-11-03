import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { audit, resetDemo, saveRounds, syncTickets } from '../lib/database.js';

export const celebrationPlan = [
  { name: 'Festive Rewards', prize_label: 'Festive Surprise Voucher', winner_count: 15, batch_size: 5 },
  { name: 'Celebration Rewards', prize_label: 'Celebration Special Voucher', winner_count: 8, batch_size: 4 },
  { name: 'Grand Finale', prize_label: 'Grand Celebration Voucher', winner_count: 2, batch_size: 2 },
];
const action = 'event.celebration_plan_25';

export async function updateCelebrationLabels(pool, eventIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of [...new Set(eventIds)].sort((a, b) => a - b)) {
      const { rows: [event] } = await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [id]);
      if (!event || !event.title.includes('5 November 2026')) throw new Error(`Event ${id} is not a November 5 celebration.`);
      const { rows: rounds } = await client.query('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position', [id]);
      if (rounds.length !== celebrationPlan.length || rounds.some((r, i) => r.name !== celebrationPlan[i].name ||
          r.winner_count !== celebrationPlan[i].winner_count || r.batch_size !== celebrationPlan[i].batch_size)) {
        throw new Error(`Event ${id} has a different plan; review before relabeling.`);
      }
      const changed = [];
      for (const [i, round] of rounds.entries()) {
        const label = celebrationPlan[i].prize_label;
        const { rows: draws } = await client.query(
          'UPDATE draws SET prize_label=$2 WHERE round_id=$1 AND event_id=$3 AND prize_label<>$2 RETURNING id',
          [round.id, label, id]);
        if (round.prize_label === label && !draws.length) continue;
        await client.query('UPDATE rounds SET prize_label=$2 WHERE id=$1', [round.id, label]);
        changed.push({ roundId: round.id, previousLabel: round.prize_label, label, drawIds: draws.map(d => d.id) });
      }
      if (changed.length) await audit(client, id, 'event.celebration_prizes_relabelled', { changed });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function updateCelebrationPlan(pool, eventIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const id of [...new Set(eventIds)].sort((a, b) => a - b)) {
      const { rows: [event] } = await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [id]);
      if (!event) throw new Error(`Event ${id} not found.`);
      if ((await client.query('SELECT id FROM audit_log WHERE event_id=$1 AND action=$2', [id, action])).rows.length) {
        results.push({ eventId: id, alreadyUpdated: true });
        continue;
      }
      if (event.status === 'ended' || !event.title.includes('5 November 2026')) {
        throw new Error(`Event ${id} is not an active November 5 celebration.`);
      }
      const draws = (await client.query('SELECT * FROM draws WHERE event_id=$1 ORDER BY id', [id])).rows;
      const rounds = (await client.query('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position', [id])).rows;
      const people = (await client.query('SELECT * FROM people WHERE event_id=$1 ORDER BY id', [id])).rows;
      if (!event.is_demo && draws.length) throw new Error(`Real event ${id} has winners; do not replace its plan.`);
      if (event.is_demo && people.some(p => !/^Demo Employee \d+$/.test(p.name) || !/^demo\d+@example\.com$/.test(p.email))) {
        throw new Error(`Demo ${id} contains unexpected employees; review before seeding.`);
      }
      if (draws.some(d => new Date(d.reveal_at).getTime() > Date.now())) throw new Error(`Wait for event ${id} to finish revealing.`);
      await audit(client, id, action, { previousEvent: event, previousRounds: rounds, previousDraws: draws,
        plan: celebrationPlan, reason: 'Owner-approved three-round, six-roll plan; reset only demo results.' });
      if (event.is_demo) await resetDemo(client, event);
      await client.query("UPDATE events SET status='open',rounds_locked_at=NULL,allowed_domains='' WHERE id=$1", [id]);
      await saveRounds(client, { ...event, status: 'open', rounds_locked_at: null }, celebrationPlan);
      if (event.is_demo) {
        for (let n = 1; n <= 40; n++) {
          const suffix = String(n).padStart(2, '0');
          const email = `demo${suffix}@example.com`;
          if (people.some(p => p.email === email || p.email === `demo${n}@example.com`)) continue;
          const { rows: [person] } = await client.query(
            `INSERT INTO people(event_id,name,email,department,approved,extra_bonus)
             VALUES($1,$2,$3,$4,TRUE,$5) RETURNING *`,
            [id, `Demo Employee ${suffix}`, email, ['BU1', 'BU2', 'HR'][(n - 1) % 3], n % 5]);
          await syncTickets(client, event, person);
        }
        await client.query("UPDATE events SET title='DEMO ONLY - Reusable 40-Employee Showcase - 5 November 2026' WHERE id=$1", [id]);
      }
      await client.query('UPDATE events SET status=$2,rounds_locked_at=$3 WHERE id=$1',
        [id, event.is_demo ? 'live' : event.status, event.is_demo || event.rounds_locked_at ? new Date() : null]);
      results.push({ eventId: id, updated: true, prizes: 25, rolls: 6, demoEmployees: event.is_demo ? 40 : undefined });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('Use --apply to confirm the new plan for real event 1 and demo 3, including demo reset.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = url.hostname.replace('-pooler.', '.');
  url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({ connectionString: url.toString() });
  try {
    if (process.argv.includes('--labels-only')) {
      await updateCelebrationLabels(pool, [1, 3]);
      console.log('Prize names updated for both events without resetting results.');
    } else console.log(JSON.stringify(await updateCelebrationPlan(pool, [1, 3])));
  }
  finally { await pool.end(); }
}
