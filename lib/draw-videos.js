import { randomUUID } from 'node:crypto';
import { InputError } from './database.js';

export const drawVideos = [
  { key: 'round-1', title: 'A Diwali wish before Festive Rewards', src: '/videos/before-round-1.mp4', duration: 73.218458 },
  { key: 'round-2', title: 'A Diwali wish before Celebration Rewards', src: '/videos/before-round-2.mp4', duration: 93.590479 },
  { key: 'round-3', title: 'A Diwali wish before the Grand Finale', src: '/videos/before-final-round.mp4', duration: 73.497208 },
  { key: 'credits', title: 'Happy Diwali from our team', src: '/videos/end-credits.mp4', duration: 61.534167 },
];

export async function playDrawVideo(client, event, key) {
  const video = drawVideos.find(v => v.key === key);
  if (!event.videos_enabled || event.status !== 'live' || !video) throw new InputError('Video playback is not available for this event.');
  const active = await client.query('SELECT id FROM video_playbacks WHERE event_id=$1 AND completed_at IS NULL', [event.id]);
  if (active.rows.length) throw new InputError('A video is already playing. Finish or skip it first.');
  const revealing = await client.query('SELECT id FROM draws WHERE event_id=$1 AND reveal_at>clock_timestamp() LIMIT 1', [event.id]);
  if (revealing.rows.length) throw new InputError('Wait for all winner reveals before playing a video.');
  const { rows: rounds } = await client.query('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position', [event.id]);
  const next = rounds.find(r => !r.rolled_at);
  if (key === 'credits' ? !rounds.length || Boolean(next) :
    !next || next.rolls_completed !== 0 || `round-${next.position}` !== key) {
    throw new InputError('This video is not available at the current round.');
  }
  const { rows: [playback] } = await client.query(
    'INSERT INTO video_playbacks(id,event_id,video_key,started_at) VALUES($1,$2,$3,clock_timestamp()) RETURNING *',
    [randomUUID(), event.id, key]);
  return playback;
}
