import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withEvent, audit } from '../lib/database.js';

export async function enableDrawVideos(pool, eventId = 1) {
  return withEvent(pool, eventId, async (client, event) => {
    if (event.is_demo || !event.title.includes('5 November 2026') || event.status === 'ended') {
      throw new Error('Expected the active main November 5 celebration.');
    }
    if (event.videos_enabled) return { eventId, alreadyEnabled: true };
    const { rows: rounds } = await client.query('SELECT position,rolls_completed FROM rounds WHERE event_id=$1 ORDER BY position', [event.id]);
    if (rounds.length !== 3 || rounds.some((r, i) => r.position !== i + 1 || r.rolls_completed !== 0)) {
      throw new Error('Expected three unstarted rounds; review the draw before enabling videos.');
    }
    const draws = await client.query('SELECT id FROM draws WHERE event_id=$1 LIMIT 1', [event.id]);
    if (draws.rows.length) throw new Error('The draw has already started; review before enabling greetings.');
    await client.query('UPDATE events SET videos_enabled=TRUE WHERE id=$1', [event.id]);
    await audit(client, event.id, 'event.draw_videos_enabled', { greetings: 3, endCredits: true, automaticRoll: false });
    return { eventId, enabled: true };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('Use --apply to enable greetings for the main event without starting playback or drawing.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = url.hostname.replace('-pooler.', '.');
  url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({ connectionString: url.toString() });
  try { console.log(JSON.stringify(await enableDrawVideos(pool))); }
  finally { await pool.end(); }
}
