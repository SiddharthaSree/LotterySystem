import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { harness } from './helpers.js';
import { createApp } from '../lib/app.js';
import { initialize } from '../lib/database.js';

let h;
before(async () => { h = await harness(); });
after(async () => { await h?.pool.end(); });

test('native draw recordings have a nine-second crescendo and audible ta-da fanfare', async () => {
  for (const [file, seconds] of [['drumroll', 9], ['winner', 2]]) {
    const response = await request(h.app).get(`/audio/${file}.wav`).expect(200);
    const buffer = response.body;
    assert.ok(response.headers['content-type'].includes('audio/'));
    assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
    const rate = buffer.readUInt32LE(24);
    assert.equal(buffer.readUInt32LE(40) / (rate * 2), seconds);
    const levels = [];
    for (let second = 0; second < seconds; second++) {
      let sum = 0;
      for (let i = second * rate; i < (second + 1) * rate; i++) sum += (buffer.readInt16LE(44 + i * 2) / 32767) ** 2;
      assert.ok(Math.sqrt(sum / rate) > .005, `${file} has sound during second ${second}`);
      levels.push(Math.sqrt(sum / rate));
    }
    if (file === 'drumroll') assert.ok(levels[8] > levels[0] * 3, 'Crescendo must build measurably');
  }
});

test('employee signup is pending, restricted by domain, approved by admin, then email-only login works', async () => {
  const employee = request.agent(h.app);
  let csrf = (await employee.get('/api/session')).body.csrf;
  await employee.post('/api/events/1/signup').set('x-csrf-token', csrf).send({ name: 'Wrong domain', email: 'someone@example.com' }).expect(400);
  let response = await employee.post('/api/events/1/signup').set('x-csrf-token', csrf).send({ name: 'Asha', email: 'ASHA@gmail.com' }).expect(201);
  csrf = response.body.csrf;
  const me = (await employee.get('/api/me').expect(200)).body;
  assert.equal(me.person.approved, false);
  assert.equal(me.tickets.length, 1);
  await employee.post('/api/logout').set('x-csrf-token', csrf).send({}).expect(200);
  csrf = (await employee.get('/api/session')).body.csrf;
  await employee.post('/api/events/1/login').set('x-csrf-token', csrf).send({ email: 'asha@gmail.com' }).expect(401);
  await h.write('patch', `/admin/events/1/people/${me.person.id}`, { approved: true }).expect(200);
  response = await employee.post('/api/events/1/login').set('x-csrf-token', csrf).send({ email: 'asha@gmail.com' }).expect(200);
  assert.ok(response.body.csrf);
  assert.equal((await employee.get('/api/me')).body.person.approved, true);
  const publicData = (await employee.get('/api/events/1/public')).body;
  assert.equal(JSON.stringify(publicData).includes('asha@gmail.com'), false);
});

test('registration closes at its cutoff, while admins can add late entries', async () => {
  await h.write('patch', '/admin/events/1', { ...h.settings, signup_closes_at: '2020-11-04T06:00:00+05:30' }).expect(200);
  const agent = request.agent(h.app);
  const csrf = (await agent.get('/api/session')).body.csrf;
  await agent.post('/api/events/1/signup').set('x-csrf-token', csrf).send({ name: 'Late', email: 'late@gmail.com' }).expect(400);
  assert.ok((await h.add('Late admin entry', 'late@example.com')).approved);
  await h.write('patch', '/admin/events/1', h.settings).expect(200);
});

test('task completion is idempotent and reversible, respects cap, and updates stable ticket identifiers', async () => {
  const person = await h.add('Bonus Tester', 'bonus@gmail.com');
  const tasks = (await h.admin.get('/api/admin/events/1')).body.tasks;
  const check = () => h.pool.query('SELECT id,source_key FROM tickets WHERE person_id=$1 AND active=TRUE ORDER BY id', [person.id]);
  const path = `/admin/events/1/people/${person.id}/tasks/${tasks[0].id}`;
  await h.write('put', path, { done: true }).expect(200);
  const first = (await check()).rows;
  assert.equal(first.length, 2);
  await h.write('put', path, { done: true }).expect(200);
  assert.deepEqual((await check()).rows, first);
  await h.write('put', path, { done: false }).expect(200);
  assert.equal((await check()).rows.length, 1);
  await h.write('put', path, { done: true }).expect(200);
  assert.deepEqual((await check()).rows, first);
  for (const task of tasks.slice(1)) await h.write('put', `/admin/events/1/people/${person.id}/tasks/${task.id}`, { done: true }).expect(200);
  assert.equal((await check()).rows.length, 5);
  await h.write('patch', '/admin/events/1', { ...h.settings, bonus_cap: 2 }).expect(200);
  assert.equal((await check()).rows.length, 3);
  await h.write('patch', `/admin/events/1/tasks/${tasks[0].id}`, { ...tasks[0], active: false }).expect(200);
  assert.equal((await check()).rows.some(t => t.source_key.startsWith(`task-${tasks[0].id}-`)), false);
  await h.write('patch', '/admin/events/1', h.settings).expect(200);
  await h.write('patch', `/admin/events/1/tasks/${tasks[0].id}`, tasks[0]).expect(200);
});

test('admin manual bonus uses the same cap and can be removed', async () => {
  const person = await h.add('Manual Tester', 'manual@gmail.com');
  const count = async () => Number((await h.pool.query('SELECT COUNT(*) AS count FROM tickets WHERE person_id=$1 AND active=TRUE', [person.id])).rows[0].count);
  await h.write('patch', `/admin/events/1/people/${person.id}`, { extra_bonus: 100 }).expect(200);
  assert.equal(await count(), 5);
  await h.write('patch', `/admin/events/1/people/${person.id}`, { extra_bonus: 0 }).expect(200);
  assert.equal(await count(), 1);
  await h.write('patch', `/admin/events/1/people/${person.id}`, { extra_bonus: -1 }).expect(400);
});

test('admin writes require both admin authentication and CSRF; bad credentials do not authenticate', async () => {
  const agent = request.agent(h.app);
  const csrf = (await agent.get('/api/session')).body.csrf;
  await agent.get('/api/admin/events/1').expect(401);
  await agent.post('/api/admin/events/1/people').set('x-csrf-token', csrf).send({ name: 'X', email: 'x@gmail.com' }).expect(401);
  await agent.post('/api/admin/login').set('x-csrf-token', csrf).send({ email: h.config.adminEmail, password: 'wrong' }).expect(401);
  await h.admin.patch('/api/admin/events/1').send(h.settings).expect(403);
  await h.write('patch', '/admin/events/1', { ...h.settings, bonus_cap: 1.5 }).expect(400);
  await h.write('patch', '/admin/events/1', { ...h.settings, allowed_domains: 'gmail' }).expect(400);
});

test('batch draws automatically award offline winners, clamp capacity, and exclude all their tickets', async () => {
  const created = (await h.write('post', '/admin/events', { ...h.settings, title: 'Draw test', prize_count: 2 }).expect(201)).body;
  const root = `/admin/events/${created.id}`;
  await h.write('post', `${root}/people`, { name: 'Only Candidate', email: 'only@gmail.com' }).expect(201);
  const candidate = (await h.admin.get(`/api${root}`)).body.people[0];
  await h.write('patch', `${root}/people/${candidate.id}`, { extra_bonus: 5 }).expect(200);
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', root, { ...created, status: 'live' }).expect(200);
  for (const invalid of [0, -1, 1.5, 1001, '', null, true]) {
    await h.write('post', `${root}/draw`, { winner_count: invalid }).expect(400);
  }
  const selection = (await h.write('post', `${root}/draw`, { prize_label: 'Gift hamper', winner_count: 5 }).expect(201)).body;
  assert.equal(selection.winner_count, 1);
  assert.equal(selection.requested_count, 5);
  assert.equal(selection.reduced, true);
  const draw = selection.draws[0];
  assert.equal(draw.person_id, candidate.id);
  assert.equal(draw.status, 'claimed');
  assert.ok(draw.resolved_at);
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', root, { ...created, status: 'ended' }).expect(400);
  const rolling = (await h.admin.get(`/api/events/${created.id}/public`)).body;
  assert.equal(rolling.reveal_duration_ms, 10000);
  assert.equal(rolling.draws[0].name, null);
  assert.equal(rolling.draws[0].reveal_ends_at - rolling.draws[0].reveal_starts_at, 10000);
  assert.equal(rolling.remaining, 1);
  assert.equal(rolling.stats.tickets, 0);
  assert.equal(rolling.batch.active, true);
  assert.equal(rolling.batch.requested_count, 5);
  await h.write('post', `${root}/draws/${draw.id}/resolve`, { status: 'absent' }).expect(410);
  await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE id=$1", [draw.id]);
  assert.equal((await h.admin.get(`/api/events/${created.id}/public`)).body.draws[0].name, 'Only Candidate');
  const data = (await h.admin.get(`/api/events/${created.id}/public`)).body;
  assert.equal(data.remaining, 1);
  assert.equal(data.stats.tickets, 0);
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', `${root}/people/${candidate.id}`, { extra_bonus: 10 }).expect(200);
  assert.equal((await h.admin.get(`/api/events/${created.id}/public`)).body.stats.tickets, 0);
  const csv = await h.admin.get(`/api${root}/export`).expect(200);
  assert.ok(csv.text.includes('only@gmail.com'));
  assert.equal((await h.admin.get(`/api${root}`)).body.people[0].won, true);
});

test('parallel batch rolls award distinct people once, cap by prizes, and preserve sequential reveals', async () => {
  const event = (await h.write('post', '/admin/events', { ...h.settings, title: 'Concurrency test', prize_count: 2 }).expect(201)).body;
  const root = `/admin/events/${event.id}`;
  for (const name of ['One', 'Two', 'Three']) await h.write('post', `${root}/people`, { name, email: `${name.toLowerCase()}@gmail.com` }).expect(201);
  const people = (await h.admin.get(`/api${root}`)).body.people;
  for (const person of people) await h.write('patch', `${root}/people/${person.id}`, { extra_bonus: 5 }).expect(200);
  await h.write('patch', root, { ...event, status: 'live' }).expect(200);
  const attempts = await Promise.all([h.write('post', `${root}/draw`, { winner_count: 3 }), h.write('post', `${root}/draw`, { winner_count: 3 })]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [201, 400]);
  const batch = attempts.find(r => r.status === 201).body;
  assert.equal(batch.winner_count, 2);
  assert.equal(batch.reduced, true);
  assert.equal(new Set(batch.draws.map(d => d.person_id)).size, 2);
  assert.equal(new Set(batch.draws.map(d => d.batch_id)).size, 1);
  assert.equal(new Date(batch.draws[1].reveal_at) - new Date(batch.draws[0].reveal_at), 12000);
  let data = (await h.admin.get(`/api/events/${event.id}/public`)).body;
  assert.equal(data.remaining, 0);
  assert.equal(data.stats.tickets, 5);
  assert.equal(data.current_draw_id, batch.draws[0].id);
  assert.ok(data.draws.every(d => d.name === null));
  assert.equal(data.draws[0].ticket_id, null);
  await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE id=$1", [batch.draws[0].id]);
  data = (await h.admin.get(`/api/events/${event.id}/public`)).body;
  assert.equal(data.current_draw_id, batch.draws[0].id);
  assert.ok(data.draws.find(d => d.id === batch.draws[0].id).name);
  assert.equal(data.draws.find(d => d.id === batch.draws[1].id).name, null);
  assert.equal(data.batch.active, true);
  await h.write('patch', root, { ...event, prize_count: 1, status: 'live' }).expect(400);
  await h.write('patch', root, { ...event, status: 'ended' }).expect(400);
  await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE event_id=$1", [event.id]);
  data = (await h.admin.get(`/api/events/${event.id}/public`)).body;
  assert.equal(data.batch.active, false);
  assert.equal(data.current_draw_id, batch.draws[1].id);
  assert.ok(data.draws.every(d => d.name));
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', root, { ...event, status: 'ended' }).expect(200);
  await h.write('post', `${root}/people`, { name: 'Too late', email: 'after@gmail.com' }).expect(400);
  await h.write('patch', root, { ...event, status: 'open' }).expect(400);
  const otherPerson = (await h.admin.get('/api/admin/events/1')).body.people[0];
  const ownTask = (await h.admin.get(`/api${root}`)).body.tasks[0];
  await h.write('put', `/admin/events/1/people/${otherPerson.id}/tasks/${ownTask.id}`, { done: true }).expect(404);
});

test('awarded employees stay excluded across separate rolls and an award survives restart without viewers', async () => {
  const event = (await h.write('post', '/admin/events', { ...h.settings, title: 'Separate rolls', prize_count: 3 }).expect(201)).body;
  const root = `/admin/events/${event.id}`;
  for (const name of ['Alpha', 'Beta']) await h.write('post', `${root}/people`, { name, email: `${name.toLowerCase()}@example.com` }).expect(201);
  await h.write('patch', root, { ...event, status: 'live' }).expect(200);
  const first = (await h.write('post', `${root}/draw`, {}).expect(201)).body.draws[0];
  await h.write('patch', `${root}/people/${first.person_id}`, { extra_bonus: 100 }).expect(200);
  await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE id=$1", [first.id]);
  const second = (await h.write('post', `${root}/draw`, {}).expect(201)).body.draws[0];
  assert.notEqual(first.person_id, second.person_id);
  await initialize(h.pool);
  assert.equal((await h.pool.query("SELECT COUNT(*)::int AS count FROM draws WHERE event_id=$1 AND status='claimed'", [event.id])).rows[0].count, 2);
});

test('upgrade automatically awards existing pending selections once and preserves past absent records', async () => {
  const event = (await h.write('post', '/admin/events', { ...h.settings, title: 'Upgrade test' }).expect(201)).body;
  const root = `/admin/events/${event.id}`;
  await h.write('post', `${root}/people`, { name: 'Pending Person', email: 'pending@example.com' }).expect(201);
  const person = (await h.admin.get(`/api${root}`)).body.people[0];
  const ticket = (await h.pool.query('SELECT id FROM tickets WHERE person_id=$1', [person.id])).rows[0];
  await h.pool.query("INSERT INTO draws(event_id,person_id,ticket_id,prize_label,status) VALUES($1,$2,$3,'Old prize','absent')", [event.id, person.id, ticket.id]);
  await h.pool.query("INSERT INTO draws(event_id,person_id,ticket_id,prize_label) VALUES($1,$2,$3,'Pending prize')", [event.id, person.id, ticket.id]);
  await initialize(h.pool);
  await initialize(h.pool);
  const rows = (await h.pool.query('SELECT status FROM draws WHERE event_id=$1 ORDER BY id', [event.id])).rows;
  assert.deepEqual(rows.map(d => d.status), ['absent', 'claimed']);
  const audits = (await h.pool.query("SELECT id FROM audit_log WHERE event_id=$1 AND action='draw.automatically_awarded_on_upgrade'", [event.id])).rows;
  assert.equal(audits.length, 1);
  assert.equal((await h.admin.get(`/api/events/${event.id}/public`)).body.stats.tickets, 0);
});

test('public HTML and static assets are served with protective headers', async () => {
  const response = await request(h.app).get('/').expect(200);
  assert.ok(response.text.includes('id="app"'));
  assert.ok(response.headers['content-security-policy'].includes("script-src 'self'"));
  await request(h.app).get('/app.js').expect(200);
  await request(h.app).get('/styles.css').expect(200);
  const logo = await request(h.app).get('/company-logo.png').expect(200);
  assert.ok(logo.headers['content-type'].startsWith('image/png'));
  await request(h.app).get('/healthz').expect(200);
  await request(h.app).get('/.env').expect(404);
});

test('PostgreSQL sessions survive app recreation and production cookies require HTTPS', async () => {
  const first = createApp({ pool: h.pool, config: h.config });
  const agent = request.agent(first);
  const csrf = (await agent.get('/api/session').expect(200)).body.csrf;
  const login = await agent.post('/api/admin/login').set('x-csrf-token', csrf)
    .send({ email: h.config.adminEmail, password: h.config.adminPassword }).expect(200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const second = createApp({ pool: h.pool, config: h.config });
  const restored = await request(second).get('/api/session').set('Cookie', cookie).expect(200);
  assert.equal(restored.body.admin, true);
  assert.equal(restored.body.csrf, login.body.csrf);
  const production = createApp({ pool: h.pool, config: { ...h.config, production: true } });
  const secure = await request(production).get('/api/session').set('X-Forwarded-Proto', 'https').expect(200);
  assert.ok(secure.headers['set-cookie'][0].includes('Secure'));
  assert.ok(secure.headers['set-cookie'][0].includes('HttpOnly'));
  assert.ok(secure.headers['set-cookie'][0].includes('SameSite=Lax'));
});
