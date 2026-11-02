import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { harness } from './helpers.js';
import { createApp } from '../lib/app.js';

let h;
before(async () => { h = await harness(); });
after(async () => { await h?.pool.end(); });

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
  assert.equal((await check()).rows.length, 6);
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
  assert.equal(await count(), 6);
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

test('absent selections preserve prizes and eligibility; a claim excludes all tickets and cannot be resolved twice', async () => {
  const created = (await h.write('post', '/admin/events', { ...h.settings, title: 'Draw test', prize_count: 2 }).expect(201)).body;
  const root = `/admin/events/${created.id}`;
  await h.write('post', `${root}/people`, { name: 'Only Candidate', email: 'only@gmail.com' }).expect(201);
  const candidate = (await h.admin.get(`/api${root}`)).body.people[0];
  await h.write('patch', `${root}/people/${candidate.id}`, { extra_bonus: 5 }).expect(200);
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', root, { ...created, status: 'live' }).expect(200);
  let selection = (await h.write('post', `${root}/draw`, { prize_label: 'Gift hamper' }).expect(201)).body;
  assert.equal(selection.person_id, candidate.id);
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', root, { ...created, status: 'ended' }).expect(400);
  const rolling = (await h.admin.get(`/api/events/${created.id}/public`)).body;
  assert.equal(rolling.reveal_duration_ms, 10000);
  assert.equal(rolling.draws[0].name, null);
  assert.equal(rolling.draws[0].reveal_ends_at - new Date(rolling.draws[0].created_at).getTime(), 10000);
  await h.write('post', `${root}/draws/${selection.id}/resolve`, { status: 'absent' }).expect(400);
  await h.write('post', `${root}/draws/${selection.id}/resolve`, { status: 'claimed' }).expect(400);
  await h.pool.query("UPDATE draws SET created_at=NOW()-INTERVAL '11 seconds' WHERE id=$1", [selection.id]);
  assert.equal((await h.admin.get(`/api/events/${created.id}/public`)).body.draws[0].name, 'Only Candidate');
  await h.write('post', `${root}/draws/${selection.id}/resolve`, { status: 'absent' }).expect(200);
  let data = (await h.admin.get(`/api/events/${created.id}/public`)).body;
  assert.equal(data.remaining, 2);
  assert.equal(data.stats.tickets, 6);
  selection = (await h.write('post', `${root}/draw`, { prize_label: 'Gift hamper' }).expect(201)).body;
  assert.equal(selection.person_id, candidate.id);
  await h.pool.query("UPDATE draws SET created_at=NOW()-INTERVAL '11 seconds' WHERE id=$1", [selection.id]);
  await h.write('post', `${root}/draws/${selection.id}/resolve`, { status: 'claimed' }).expect(200);
  await h.write('post', `${root}/draws/${selection.id}/resolve`, { status: 'claimed' }).expect(400);
  data = (await h.admin.get(`/api/events/${created.id}/public`)).body;
  assert.equal(data.remaining, 1);
  assert.equal(data.stats.tickets, 0);
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', `${root}/people/${candidate.id}`, { extra_bonus: 10 }).expect(200);
  assert.equal((await h.admin.get(`/api/events/${created.id}/public`)).body.stats.tickets, 0);
  const csv = await h.admin.get(`/api${root}/export`).expect(200);
  assert.ok(csv.text.includes('only@gmail.com'));
});

test('parallel draw and claim requests cannot consume a prize twice; ended events are immutable and isolated', async () => {
  const event = (await h.write('post', '/admin/events', { ...h.settings, title: 'Concurrency test', prize_count: 1 }).expect(201)).body;
  const root = `/admin/events/${event.id}`;
  for (const name of ['One', 'Two']) await h.write('post', `${root}/people`, { name, email: `${name.toLowerCase()}@gmail.com` }).expect(201);
  await h.write('patch', root, { ...event, status: 'live' }).expect(200);
  const attempts = await Promise.all([h.write('post', `${root}/draw`, {}), h.write('post', `${root}/draw`, {})]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [201, 400]);
  const draw = attempts.find(r => r.status === 201).body;
  await h.pool.query("UPDATE draws SET created_at=NOW()-INTERVAL '11 seconds' WHERE id=$1", [draw.id]);
  const claims = await Promise.all([h.write('post', `${root}/draws/${draw.id}/resolve`, { status: 'claimed' }), h.write('post', `${root}/draws/${draw.id}/resolve`, { status: 'claimed' })]);
  assert.deepEqual(claims.map(r => r.status).sort(), [200, 400]);
  await h.write('post', `${root}/draw`, {}).expect(400);
  await h.write('patch', root, { ...event, status: 'ended' }).expect(200);
  await h.write('post', `${root}/people`, { name: 'Too late', email: 'after@gmail.com' }).expect(400);
  await h.write('patch', root, { ...event, status: 'open' }).expect(400);
  const otherPerson = (await h.admin.get('/api/admin/events/1')).body.people[0];
  const ownTask = (await h.admin.get(`/api${root}`)).body.tasks[0];
  await h.write('put', `/admin/events/1/people/${otherPerson.id}/tasks/${ownTask.id}`, { done: true }).expect(404);
});

test('public HTML and static assets are served with protective headers', async () => {
  const response = await request(h.app).get('/').expect(200);
  assert.ok(response.text.includes('id="app"'));
  assert.ok(response.headers['content-security-policy'].includes("script-src 'self'"));
  await request(h.app).get('/app.js').expect(200);
  await request(h.app).get('/styles.css').expect(200);
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
