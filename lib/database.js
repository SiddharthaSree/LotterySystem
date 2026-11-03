import { readFile } from 'node:fs/promises';
import { randomInt, randomUUID } from 'node:crypto';
import { DIWALI_SIGNUP_CUTOFF, DIWALI_BONUS_CAP, diwaliTasks } from './diwali-2026.js';

export const DRAW_REVEAL_MS = 10000;
export const DRAW_HOLD_MS = 2000;

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

export async function initialize(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(4262026)");
    await client.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    const { rows: numberedTickets } = await client.query(
      `WITH updated AS (UPDATE tickets SET ticket_number=next_ticket_number() WHERE ticket_number IS NULL
       RETURNING id,person_id,ticket_number)
       SELECT u.id,u.ticket_number,p.event_id FROM updated u JOIN people p ON p.id=u.person_id ORDER BY u.id`);
    for (const eventId of new Set(numberedTickets.map(ticket => ticket.event_id))) {
      await audit(client, eventId, 'tickets.random_numbers_assigned', {
        tickets: numberedTickets.filter(ticket => ticket.event_id === eventId).map(ticket => ({ ticketId: ticket.id, ticketNumber: ticket.ticket_number })),
      });
    }
    await client.query('ALTER TABLE tickets ALTER COLUMN ticket_number SET NOT NULL');
    const { rows: pending } = await client.query(
      "UPDATE draws SET status='claimed',resolved_at=NOW() WHERE status='pending' RETURNING id,event_id,person_id");
    for (const draw of pending) {
      await audit(client, draw.event_id, 'draw.automatically_awarded_on_upgrade', { drawId: draw.id, personId: draw.person_id });
    }
    const existing = await client.query('SELECT id FROM events LIMIT 1');
    if (!existing.rows.length) {
      await createEvent(client, {
        title: 'CSI Solution 2026 Lucky Draw',
        signup_closes_at: DIWALI_SIGNUP_CUTOFF,
        allowed_domains: 'gmail.com', bonus_cap: DIWALI_BONUS_CAP, prize_count: 5,
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
  for (const [title, description] of diwaliTasks) {
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

export async function resetDemo(client, event) {
  if (!event.is_demo) throw new InputError('Only a designated demo event can be reset.', 403);
  const { rows: draws } = await client.query('SELECT * FROM draws WHERE event_id=$1 ORDER BY id', [event.id]);
  if (draws.some(draw => draw.reveal_at && new Date(draw.reveal_at).getTime() > Date.now())) {
    throw new InputError('Wait for the current winner reveals to finish before resetting the demo.');
  }
  const { rows: rounds } = await client.query('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position', [event.id]);
  await audit(client, event.id, 'demo.reset', { draws, rounds, previousStatus: event.status });
  await client.query('DELETE FROM draws WHERE event_id=$1', [event.id]);
  await client.query('UPDATE rounds SET awarded_count=NULL,batch_id=NULL,rolled_at=NULL WHERE event_id=$1', [event.id]);
  await client.query("UPDATE events SET status='live' WHERE id=$1", [event.id]);
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
    const restored = await client.query('UPDATE tickets SET active=TRUE WHERE person_id=$1 AND source_key=$2 RETURNING id', [person.id, source]);
    if (!restored.rows.length) {
      await client.query('INSERT INTO tickets(person_id,source_key,active) VALUES($1,$2,TRUE)', [person.id, source]);
    }
  }
}

export async function syncAll(client, event) {
  const { rows } = await client.query('SELECT * FROM people WHERE event_id=$1 ORDER BY id', [event.id]);
  for (const person of rows) await syncTickets(client, event, person);
}

export async function saveRounds(client, event, plan) {
  editable(event);
  if (event.status !== 'open' || event.rounds_locked_at) throw new InputError('Round plans are locked once the event goes Live.');
  const { rows } = await client.query('SELECT id FROM draws WHERE event_id=$1 LIMIT 1', [event.id]);
  if (rows.length) throw new InputError('A round plan cannot be added or changed after any draw has taken place.');
  if (!Array.isArray(plan) || !plan.length || plan.length > 100) throw new InputError('Configure between 1 and 100 rounds.');
  const rounds = plan.map(round => {
    if (!round || typeof round !== 'object') throw new InputError('Each round must include a name, prize and winner count.');
    return {
      name: text(round.name, 'Round name'),
      prize_label: text(round.prize_label, 'Round prize'),
      winner_count: integer(round.winner_count, 'Round winners', 1, 1000),
    };
  });
  const total = rounds.reduce((sum, round) => sum + round.winner_count, 0);
  if (total > 1000) throw new InputError('The round plan may contain at most 1000 prizes in total.');
  await client.query('DELETE FROM rounds WHERE event_id=$1', [event.id]);
  for (const [index, round] of rounds.entries()) {
    await client.query('INSERT INTO rounds(event_id,position,name,prize_label,winner_count) VALUES($1,$2,$3,$4,$5)',
      [event.id, index + 1, round.name, round.prize_label, round.winner_count]);
  }
  await client.query('UPDATE events SET prize_count=$2 WHERE id=$1', [event.id, total]);
  await audit(client, event.id, 'rounds.planned', { rounds, totalPrizes: total });
}

export async function rollRound(client, event, roundId) {
  const { rows: rounds } = await client.query('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position', [event.id]);
  const next = rounds.find(round => round.rolled_at === null);
  if (!next || next.id !== integer(roundId, 'Round ID', 1, 2147483647)) {
    throw new InputError('This round is not the next unrolled round. Refresh the draw page.');
  }
  if (!event.rounds_locked_at) throw new InputError('Set the event to Live to lock the plan before rolling.');
  const result = await selectWinners(client, event, next.prize_label, next.winner_count, true);
  await client.query('UPDATE rounds SET awarded_count=$2,batch_id=$3,rolled_at=NOW() WHERE id=$1',
    [next.id, result.winner_count, result.batch_id]);
  await audit(client, event.id, 'round.rolled', {
    roundId: next.id, name: next.name, requested: next.winner_count, awarded: result.winner_count,
    unfilled: next.winner_count - result.winner_count,
  });
  return { ...result, round_id: next.id, round_name: next.name };
}

export async function selectWinners(client, event, label, requestedCount = 1, allowEmpty = false) {
  if (event.status !== 'live') throw new InputError('Set the event to Live before drawing.');
  const requested = integer(requestedCount, 'Number of winners', 1, 1000);
  const prizeLabel = text(label || 'Lucky draw prize', 'Prize label');
  const { rows: [counts] } = await client.query(
    `SELECT COUNT(*)::int AS awarded,
     COALESCE(BOOL_OR(reveal_at > clock_timestamp()),FALSE) AS revealing
     FROM draws WHERE event_id=$1 AND status='claimed'`, [event.id]);
  if (counts.revealing) throw new InputError('Wait for all winners in the current roll to be revealed.');
  const { rows: [shortfall] } = await client.query(
    'SELECT COALESCE(SUM(winner_count-awarded_count),0)::int AS count FROM rounds WHERE event_id=$1 AND rolled_at IS NOT NULL', [event.id]);
  const remaining = event.prize_count - counts.awarded - shortfall.count;
  if (remaining <= 0 && !allowEmpty) throw new InputError('All prizes have been awarded.');
  const { rows: tickets } = await client.query(
    `SELECT t.id,t.person_id,t.ticket_number FROM tickets t JOIN people p ON p.id=t.person_id
     WHERE p.event_id=$1 AND p.approved=TRUE AND t.active=TRUE
     AND NOT EXISTS(SELECT 1 FROM draws d WHERE d.person_id=p.id AND d.status='claimed')
     ORDER BY t.id`, [event.id]);
  if (!tickets.length && !allowEmpty) throw new InputError('There are no eligible tickets left.');
  const count = Math.min(requested, remaining, new Set(tickets.map(t => t.person_id)).size);
  const batchId = randomUUID();
  const startsAt = Date.now();
  const draws = [];
  let eligibleTickets = tickets;
  for (let index = 0; index < count; index++) {
    const ticket = eligibleTickets[randomInt(eligibleTickets.length)];
    const revealAt = new Date(startsAt + index * (DRAW_REVEAL_MS + DRAW_HOLD_MS) + DRAW_REVEAL_MS).toISOString();
    const { rows: [draw] } = await client.query(
      `INSERT INTO draws(event_id,person_id,ticket_id,prize_label,status,resolved_at,batch_id,reveal_at,requested_count)
       VALUES($1,$2,$3,$4,'claimed',NOW(),$5,$6,$7) RETURNING *`,
      [event.id, ticket.person_id, ticket.id, prizeLabel, batchId, revealAt, requested]);
    await audit(client, event.id, 'draw.awarded', {
      drawId: draw.id, personId: ticket.person_id, ticketId: ticket.id, ticketNumber: ticket.ticket_number,
      batchId, eligibleTickets: eligibleTickets.length, attendanceRequired: false,
    });
    draws.push({ ...draw, ticket_number: ticket.ticket_number });
    eligibleTickets = eligibleTickets.filter(t => t.person_id !== ticket.person_id);
  }
  await audit(client, event.id, 'draw.batch_awarded', { batchId, requested, awarded: count });
  return { draws, batch_id: batchId, requested_count: requested, winner_count: count, reduced: count < requested };
}
