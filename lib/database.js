import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function integer(value, label, min = 0, max = 100) {
  if (value === '' || value === null || typeof value === 'boolean' ||
      !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new InputError(`${label} must be a whole number between ${min} and ${max}.`);
  }
  return Number(value);
}

export function text(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new InputError(`${label} is required (maximum ${max} characters).`);
  }
  return value.trim();
}

export function emailAddress(value) {
  const email = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) throw new InputError('Enter a valid email address.');
  return email;
}

const demoTasks = [
  ['Appreciate a colleague', 'Recognise a colleague through Keka. Suggested window: 1-3 November.'],
  ['Share a positive experience', 'Voluntarily share on LinkedIn, or complete an equivalent internal activity. Both count as this one task. Suggested window: 1-3 November.'],
  ['Join the Diwali quiz', 'Participate in the quiz announced by the coordinators.'],
  ['Dress in ethnic wear', 'Join online or in person on 4 November.'],
  ['Join a team activity', 'Participate in a team-building activity or game on 4 November.'],
  ['Share an engagement idea', 'Suggest an idea to improve employee engagement. Suggested window: 1-3 November.'],
];

export async function initialize(pool) {
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(4262026)");
    const existing = await client.query('SELECT id FROM events LIMIT 1');
    if (!existing.rows.length) {
      await createEvent(client, {
        title: 'CSI Solution 2026 Lucky Draw',
        signup_closes_at: '2026-11-04T06:00:00+05:30',
        allowed_domains: 'gmail.com', bonus_cap: 5, prize_count: 5,
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function eventSettings(body) {
  const title = text(body.title, 'Event title');
  const cutoff = new Date(body.signup_closes_at);
  if (!Number.isFinite(cutoff.getTime())) throw new InputError('Enter a valid registration deadline.');
  const domains = text(body.allowed_domains, 'Allowed email domains', 500)
    .toLowerCase().split(/[,;\s]+/).map(d => d.replace(/^@/, '')).filter(Boolean);
  if (!domains.length || domains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(d))) {
    throw new InputError('Use complete email domains separated by commas.');
  }
  return { title, signup_closes_at: cutoff.toISOString(), allowed_domains: [...new Set(domains)].join(','),
    bonus_cap: integer(body.bonus_cap, 'Bonus cap'), prize_count: integer(body.prize_count, 'Prize count', 1, 1000) };
}

export async function createEvent(client, settings) {
  const s = eventSettings(settings);
  const { rows: [event] } = await client.query(
    'INSERT INTO events(title,signup_closes_at,allowed_domains,bonus_cap,prize_count) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [s.title, s.signup_closes_at, s.allowed_domains, s.bonus_cap, s.prize_count]);
  for (const [title, description] of demoTasks) {
    await client.query('INSERT INTO tasks(event_id,title,description) VALUES($1,$2,$3)', [event.id, title, description]);
  }
  return event;
}

export async function withEvent(pool, id, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [event] } = await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [integer(id, 'Event ID', 1, 2147483647)]);
    if (!event) throw new InputError('Event not found.', 404);
    const result = await callback(client, event);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function editable(event) {
  if (event.status === 'ended') throw new InputError('This event has ended. Create a new event to run another draw.');
}

export async function audit(client, eventId, action, details) {
  await client.query('INSERT INTO audit_log(event_id,action,details) VALUES($1,$2,$3)', [eventId, action, JSON.stringify(details)]);
}

export async function syncTickets(client, event, person) {
  const sources = ['base'];
  let remaining = event.bonus_cap;
  const { rows } = await client.query(
    `SELECT t.id,t.reward FROM tasks t JOIN completions c ON c.task_id=t.id
     WHERE c.person_id=$1 AND c.done=TRUE AND t.active=TRUE AND t.event_id=$2 ORDER BY t.id`,
    [person.id, event.id]);
  for (const task of rows) {
    const allocated = Math.min(remaining, task.reward);
    for (let n = 1; n <= allocated; n++) sources.push(`task-${task.id}-${n}`);
    remaining -= allocated;
  }
  for (let n = 1; n <= Math.min(remaining, person.extra_bonus); n++) sources.push(`manual-${n}`);
  await client.query('UPDATE tickets SET active=FALSE WHERE person_id=$1', [person.id]);
  for (const source of sources) {
    await client.query(`INSERT INTO tickets(person_id,source_key,active) VALUES($1,$2,TRUE)
      ON CONFLICT(person_id,source_key) DO UPDATE SET active=TRUE`, [person.id, source]);
  }
}

export async function syncAll(client, event) {
  const { rows } = await client.query('SELECT * FROM people WHERE event_id=$1 ORDER BY id', [event.id]);
  for (const person of rows) await syncTickets(client, event, person);
}

export async function selectWinner(client, event, label) {
  if (event.status !== 'live') throw new InputError('Set the event to Live before drawing.');
  const { rows: counts } = await client.query('SELECT status,COUNT(*)::int AS count FROM draws WHERE event_id=$1 GROUP BY status', [event.id]);
  if (counts.some(r => r.status === 'pending')) throw new InputError('Resolve the current selection first.');
  if ((counts.find(r => r.status === 'claimed')?.count || 0) >= event.prize_count) throw new InputError('All prizes have been claimed.');
  const { rows: tickets } = await client.query(
    `SELECT t.id,t.person_id FROM tickets t JOIN people p ON p.id=t.person_id
     WHERE p.event_id=$1 AND p.approved=TRUE AND t.active=TRUE
     AND NOT EXISTS(SELECT 1 FROM draws d WHERE d.person_id=p.id AND d.status='claimed')
     ORDER BY t.id`, [event.id]);
  if (!tickets.length) throw new InputError('There are no eligible tickets left.');
  const ticket = tickets[randomInt(tickets.length)];
  const { rows: [draw] } = await client.query(
    'INSERT INTO draws(event_id,person_id,ticket_id,prize_label) VALUES($1,$2,$3,$4) RETURNING *',
    [event.id, ticket.person_id, ticket.id, text(label || 'Lucky draw prize', 'Prize label')]);
  await audit(client, event.id, 'draw.selected', { drawId: draw.id, ticketId: ticket.id, eligibleTickets: tickets.length });
  return draw;
}
