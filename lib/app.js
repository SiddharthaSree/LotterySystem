import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  InputError, integer, text, emailAddress, eventSettings, createEvent, withEvent,
  editable, audit, syncTickets, syncAll, selectWinners, saveRounds, rollRound, resetDemo, DRAW_REVEAL_MS,
} from './database.js';

const id = value => integer(value, 'ID', 1, 2147483647);
const assertBoolean = value => {
  if (typeof value !== 'boolean') throw new InputError('Expected a true or false value.');
  return value;
};

export function createApp({ pool, config, sessionStore }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'connect-src': ["'self'"] } } }));
  app.use(express.json({ limit: '32kb' }));
  const PgStore = connectPgSimple(session);
  app.use(session({
    name: 'csi.sid', secret: config.sessionSecret,
    store: sessionStore || new PgStore({ pool, createTableIfMissing: true }),
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.get('/api/session', (req, res) => {
    if (!req.session.csrf) req.session.csrf = randomBytes(24).toString('hex');
    res.json({ csrf: req.session.csrf, admin: Boolean(req.session.admin), personId: req.session.personId || null });
  });
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.session.csrf || req.get('x-csrf-token') !== req.session.csrf) return next(new InputError('Session expired. Refresh the page and try again.', 403));
    next();
  });
  const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in 15 minutes.' } });
  const adminOnly = (req, _res, next) => req.session.admin ? next() : next(new InputError('Admin sign-in required.', 401));
  const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  const adminSalt = randomBytes(16);
  const expectedPassword = scryptSync(config.adminPassword, adminSalt, 64);
  app.post('/api/admin/login', authLimit, async (req, res) => {
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const candidate = scryptSync(password.slice(0, 512), adminSalt, 64);
    if (String(req.body.email || '').trim().toLowerCase() !== config.adminEmail.toLowerCase() ||
      password.length > 512 || !timingSafeEqual(expectedPassword, candidate)) throw new InputError('Incorrect admin credentials.', 401);
    await regenerate(req);
    req.session.admin = true;
    req.session.csrf = randomBytes(24).toString('hex');
    res.json({ csrf: req.session.csrf });
  });
  app.post('/api/logout', (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('csi.sid');
      res.json({ ok: true });
    });
  });
  app.get('/api/events', async (_req, res) => {
    res.json((await pool.query('SELECT id,title,status,signup_closes_at FROM events ORDER BY id DESC')).rows);
  });
  app.get('/api/events/:eventId/public', async (req, res) => {
    const eventId = id(req.params.eventId);
    const { rows: [event] } = await pool.query('SELECT * FROM events WHERE id=$1', [eventId]);
    if (!event) throw new InputError('Event not found.', 404);
    const { rows: tasks } = await pool.query('SELECT * FROM tasks WHERE event_id=$1 AND active=TRUE ORDER BY id', [eventId]);
    const { rows: rounds } = await pool.query('SELECT * FROM rounds WHERE event_id=$1 ORDER BY position', [eventId]);
    const { rows: draws } = await pool.query(
      `SELECT d.id,d.prize_label,d.status,d.created_at,d.ticket_id,t.ticket_number,d.batch_id,d.reveal_at,d.requested_count,p.name FROM draws d
       JOIN people p ON p.id=d.person_id JOIN tickets t ON t.id=d.ticket_id WHERE d.event_id=$1 ORDER BY d.id DESC`, [eventId]);
    const { rows: [stats] } = await pool.query(
      `SELECT COUNT(DISTINCT p.id)::int AS participants, COUNT(t.id)::int AS tickets
       FROM people p LEFT JOIN tickets t ON t.person_id=p.id AND t.active=TRUE
       AND NOT EXISTS(SELECT 1 FROM draws d WHERE d.person_id=p.id AND d.status='claimed')
       WHERE p.event_id=$1 AND p.approved=TRUE`, [eventId]);
    const now = Date.now();
    const presentedDraws = draws.map(draw => {
      const revealEndsAt = draw.reveal_at ? new Date(draw.reveal_at).getTime() : 0;
      const startsAt = revealEndsAt - DRAW_REVEAL_MS;
      return { ...draw, name: now < revealEndsAt ? null : draw.name,
        ticket_id: now < startsAt ? null : draw.ticket_id,
        ticket_number: now < startsAt ? null : draw.ticket_number,
        reveal_starts_at: startsAt, reveal_ends_at: revealEndsAt };
    });
    const latest = presentedDraws[0];
    const batchDraws = latest?.batch_id ? presentedDraws.filter(d => d.batch_id === latest.batch_id).reverse() : [];
    const next = batchDraws.find(d => d.name === null);
    const current = next && now >= next.reveal_starts_at ? next :
      batchDraws.filter(d => d.name !== null).at(-1) || latest;
    const batch = batchDraws.length ? {
      id: latest.batch_id, requested_count: latest.requested_count, winner_count: batchDraws.length,
      active: Boolean(next), current_position: batchDraws.findIndex(d => d.id === current.id) + 1,
      ends_at: batchDraws.at(-1).reveal_ends_at,
    } : null;
    res.json({ event, tasks, draws: presentedDraws, stats, server_now: now, reveal_duration_ms: DRAW_REVEAL_MS,
      batch, rounds, current_draw_id: current?.id || null,
      remaining: event.prize_count - draws.filter(d => d.status === 'claimed').length -
        rounds.reduce((sum, round) => sum + (round.rolled_at ? round.winner_count - round.awarded_count : 0), 0) });
  });
  app.post('/api/events/:eventId/signup', authLimit, async (req, res) => {
    const eventId = id(req.params.eventId);
    const name = text(req.body.name, 'Name', 100);
    const email = emailAddress(req.body.email);
    const person = await withEvent(pool, eventId, async (client, event) => {
      editable(event);
      if (Date.now() >= new Date(event.signup_closes_at).getTime()) throw new InputError('Registration has closed. Please contact an admin.');
      if (!event.allowed_domains.split(',').includes(email.split('@')[1])) throw new InputError('This email domain is not allowed for this event.');
      const { rows } = await client.query('INSERT INTO people(event_id,name,email) VALUES($1,$2,$3) ON CONFLICT(event_id,email) DO NOTHING RETURNING *', [eventId, name, email]);
      if (!rows.length) throw new InputError('This email is already registered. Use employee sign-in.');
      await syncTickets(client, event, rows[0]);
      await audit(client, eventId, 'employee.registered', { personId: rows[0].id });
      return rows[0];
    });
    await regenerate(req);
    req.session.personId = person.id;
    req.session.csrf = randomBytes(24).toString('hex');
    res.status(201).json({ csrf: req.session.csrf });
  });
  app.post('/api/events/:eventId/login', authLimit, async (req, res) => {
    const { rows: [person] } = await pool.query('SELECT id FROM people WHERE event_id=$1 AND email=$2 AND approved=TRUE',
      [id(req.params.eventId), emailAddress(req.body.email)]);
    if (!person) throw new InputError('No approved entry found. Register first or contact an admin.', 401);
    await regenerate(req);
    req.session.personId = person.id;
    req.session.csrf = randomBytes(24).toString('hex');
    res.json({ csrf: req.session.csrf });
  });
  app.get('/api/me', async (req, res) => {
    if (!req.session.personId) throw new InputError('Employee sign-in required.', 401);
    const { rows: [person] } = await pool.query('SELECT * FROM people WHERE id=$1', [req.session.personId]);
    if (!person) throw new InputError('Entry not found.', 404);
    const { rows: tasks } = await pool.query(
      `SELECT t.*,COALESCE(c.done,FALSE) AS done FROM tasks t LEFT JOIN completions c
       ON c.task_id=t.id AND c.person_id=$1 WHERE t.event_id=$2 AND t.active=TRUE ORDER BY t.id`, [person.id, person.event_id]);
    const { rows: tickets } = await pool.query('SELECT id,ticket_number,source_key FROM tickets WHERE person_id=$1 AND active=TRUE ORDER BY id', [person.id]);
    const { rows: wins } = await pool.query("SELECT d.prize_label,d.ticket_id,t.ticket_number,d.reveal_at FROM draws d JOIN tickets t ON t.id=d.ticket_id WHERE d.person_id=$1 AND d.status='claimed'", [person.id]);
    const awardPending = wins[0]?.reveal_at && Date.now() < new Date(wins[0].reveal_at).getTime();
    res.json({ person, tasks, tickets, won: !awardPending ? wins[0]?.prize_label || null : null,
      winning_ticket_id: !awardPending ? wins[0]?.ticket_id || null : null,
      winning_ticket_number: !awardPending ? wins[0]?.ticket_number || null : null, award_pending: Boolean(awardPending) });
  });
  app.use('/api/admin', adminOnly);
  app.get('/api/admin/events/:eventId', async (req, res) => {
    const eventId = id(req.params.eventId);
    const { rows: people } = await pool.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM tickets t WHERE t.person_id=p.id AND t.active=TRUE) AS ticket_count,
       EXISTS(SELECT 1 FROM draws d WHERE d.person_id=p.id AND d.status='claimed') AS won
       FROM people p WHERE p.event_id=$1 ORDER BY p.created_at DESC,p.id DESC`, [eventId]);
    const { rows: tasks } = await pool.query('SELECT * FROM tasks WHERE event_id=$1 ORDER BY id', [eventId]);
    const { rows: completions } = await pool.query(
      'SELECT c.* FROM completions c JOIN people p ON p.id=c.person_id WHERE p.event_id=$1', [eventId]);
    const { rows: auditLog } = await pool.query('SELECT * FROM audit_log WHERE event_id=$1 ORDER BY id DESC LIMIT 100', [eventId]);
    res.json({ people, tasks, completions, auditLog });
  });
  app.post('/api/admin/events', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const event = await createEvent(client, req.body);
      await audit(client, event.id, 'event.created', { title: event.title });
      await client.query('COMMIT');
      res.status(201).json(event);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  app.patch('/api/admin/events/:eventId', async (req, res) => {
    await withEvent(pool, req.params.eventId, async (client, event) => {
      editable(event);
      const s = eventSettings(req.body);
      const { rows: rounds } = await client.query('SELECT winner_count FROM rounds WHERE event_id=$1', [event.id]);
      if (rounds.length && s.prize_count !== rounds.reduce((sum, round) => sum + round.winner_count, 0)) {
        throw new InputError('Prize count is set by the round plan. Edit the plan before going Live.');
      }
      if (!['open', 'live', 'ended'].includes(req.body.status)) throw new InputError('Choose a valid event status.');
      const { rows } = await client.query('SELECT status,COUNT(*)::int AS count FROM draws WHERE event_id=$1 GROUP BY status', [event.id]);
      const pending = rows.find(r => r.status === 'pending')?.count || 0;
      const claimed = rows.find(r => r.status === 'claimed')?.count || 0;
      if (s.prize_count < claimed + pending) throw new InputError('Prize count cannot be below already awarded prizes.');
      const active = await client.query("SELECT id FROM draws WHERE event_id=$1 AND reveal_at > clock_timestamp() LIMIT 1", [event.id]);
      if ((pending || active.rows.length) && req.body.status !== 'live') throw new InputError('Wait for all winners to be revealed before leaving Live status.');
      await client.query(`UPDATE events SET title=$2,signup_closes_at=$3,allowed_domains=$4,bonus_cap=$5,prize_count=$6,status=$7 WHERE id=$1`,
        [event.id, s.title, s.signup_closes_at, s.allowed_domains, s.bonus_cap, s.prize_count, req.body.status]);
      if (rounds.length && req.body.status === 'live') {
        await client.query('UPDATE events SET rounds_locked_at=COALESCE(rounds_locked_at,NOW()) WHERE id=$1', [event.id]);
      }
      await syncAll(client, { ...event, ...s });
      await audit(client, event.id, 'event.updated', { ...s, status: req.body.status });
    });
    res.json({ ok: true });
  });
  app.post('/api/admin/events/:eventId/reset-demo', async (req, res) => {
    if (req.body.confirm !== true) throw new InputError("Confirm that you want to clear this demo's winners and round progress.");
    await withEvent(pool, req.params.eventId, resetDemo);
    res.json({ ok: true });
  });
  app.post('/api/admin/events/:eventId/people', async (req, res) => {
    await withEvent(pool, req.params.eventId, async (client, event) => {
      editable(event);
      const { rows: [person] } = await client.query(
        'INSERT INTO people(event_id,name,email,approved) VALUES($1,$2,$3,TRUE) ON CONFLICT(event_id,email) DO NOTHING RETURNING *',
        [event.id, text(req.body.name, 'Name', 100), emailAddress(req.body.email)]);
      if (!person) throw new InputError('This email already has an entry.');
      await syncTickets(client, event, person);
      await audit(client, event.id, 'employee.added_by_admin', { personId: person.id });
    });
    res.status(201).json({ ok: true });
  });
  app.patch('/api/admin/events/:eventId/people/:personId', async (req, res) => {
    await withEvent(pool, req.params.eventId, async (client, event) => {
      editable(event);
      const { rows: [person] } = await client.query('SELECT * FROM people WHERE id=$1 AND event_id=$2', [id(req.params.personId), event.id]);
      if (!person) throw new InputError('Employee not found.', 404);
      const approved = req.body.approved === undefined ? person.approved : assertBoolean(req.body.approved);
      const extra = req.body.extra_bonus === undefined ? person.extra_bonus : integer(req.body.extra_bonus, 'Manual bonus');
      await client.query('UPDATE people SET approved=$2,extra_bonus=$3 WHERE id=$1', [person.id, approved, extra]);
      await syncTickets(client, event, { ...person, extra_bonus: extra });
      await audit(client, event.id, 'employee.updated', { personId: person.id, approved, extra_bonus: extra });
    });
    res.json({ ok: true });
  });
  app.put('/api/admin/events/:eventId/people/:personId/tasks/:taskId', async (req, res) => {
    await withEvent(pool, req.params.eventId, async (client, event) => {
      editable(event);
      const done = assertBoolean(req.body.done);
      const { rows: [person] } = await client.query('SELECT * FROM people WHERE id=$1 AND event_id=$2', [id(req.params.personId), event.id]);
      const { rows: [task] } = await client.query('SELECT id FROM tasks WHERE id=$1 AND event_id=$2', [id(req.params.taskId), event.id]);
      if (!person || !task) throw new InputError('Employee or task not found in this event.', 404);
      await client.query('INSERT INTO completions(person_id,task_id,done) VALUES($1,$2,$3) ON CONFLICT(person_id,task_id) DO UPDATE SET done=$3', [person.id, task.id, done]);
      await syncTickets(client, event, person);
      await audit(client, event.id, 'task.verified', { personId: person.id, taskId: task.id, done });
    });
    res.json({ ok: true });
  });
  const saveTask = async (req, res) => {
    await withEvent(pool, req.params.eventId, async (client, event) => {
      editable(event);
      const title = text(req.body.title, 'Task title');
      const description = String(req.body.description || '').trim();
      if (description.length > 2000) throw new InputError('Description must not exceed 2000 characters.');
      const reward = integer(req.body.reward, 'Ticket reward');
      const active = assertBoolean(req.body.active);
      let taskId = req.params.taskId ? id(req.params.taskId) : null;
      if (taskId) {
        const result = await client.query('UPDATE tasks SET title=$3,description=$4,reward=$5,active=$6 WHERE id=$1 AND event_id=$2 RETURNING id', [taskId, event.id, title, description, reward, active]);
        if (!result.rows.length) throw new InputError('Task not found.', 404);
      } else {
        const result = await client.query('INSERT INTO tasks(event_id,title,description,reward,active) VALUES($1,$2,$3,$4,$5) RETURNING id', [event.id, title, description, reward, active]);
        taskId = result.rows[0].id;
      }
      await syncAll(client, event);
      await audit(client, event.id, 'task.saved', { taskId, title, reward, active });
    });
    res.json({ ok: true });
  };
  app.post('/api/admin/events/:eventId/tasks', saveTask);
  app.patch('/api/admin/events/:eventId/tasks/:taskId', saveTask);
  app.post('/api/admin/events/:eventId/draw', async (req, res) => {
    const batch = await withEvent(pool, req.params.eventId, async (client, event) => {
      const plan = await client.query('SELECT id FROM rounds WHERE event_id=$1 LIMIT 1', [event.id]);
      if (plan.rows.length) throw new InputError('This event uses planned rounds. Use the Roll round button.');
      return selectWinners(client, event, req.body.prize_label, req.body.winner_count);
    });
    res.status(201).json(batch);
  });
  app.put('/api/admin/events/:eventId/rounds', async (req, res) => {
    await withEvent(pool, req.params.eventId, (client, event) => saveRounds(client, event, req.body.rounds));
    res.json({ ok: true });
  });
  app.post('/api/admin/events/:eventId/rounds/:roundId/roll', async (req, res) => {
    const result = await withEvent(pool, req.params.eventId,
      (client, event) => rollRound(client, event, req.params.roundId));
    res.status(201).json(result);
  });
  app.post('/api/admin/events/:eventId/draws/:drawId/resolve', (_req, _res, next) => {
    next(new InputError('Prizes are now awarded automatically, even if the winner is offline. Refresh the portal.', 410));
  });
  app.get('/api/admin/events/:eventId/export', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.name,p.email,d.prize_label,t.ticket_number,d.created_at FROM draws d JOIN people p ON p.id=d.person_id JOIN tickets t ON t.id=d.ticket_id
       WHERE d.event_id=$1 AND d.status='claimed' ORDER BY d.id`, [id(req.params.eventId)]);
    const cell = value => {
      let s = String(value ?? '');
      if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replaceAll('"', '""')}"`;
    };
    const csv = [['Name', 'Email', 'Prize', 'Ticket', 'Awarded at'], ...rows.map(r => [r.name, r.email, r.prize_label, `CSI-${r.ticket_number}`, new Date(r.created_at).toISOString()])]
      .map(row => row.map(cell).join(',')).join('\r\n');
    res.attachment(`winners-event-${id(req.params.eventId)}.csv`).type('text/csv').send(csv);
  });
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: 0 }));
  app.use('/api', (_req, _res, next) => next(new InputError('Endpoint not found.', 404)));
  app.use((error, _req, res, _next) => {
    if (!error.status) console.error(error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong. Please try again or contact an admin.' });
  });
  return app;
}
