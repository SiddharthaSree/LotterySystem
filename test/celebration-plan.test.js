import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { harness } from './helpers.js';
import { initialize } from '../lib/database.js';
import { celebrationPlan, updateCelebrationPlan } from '../scripts/update-celebration-plan.js';

test('25 prizes roll in six batches within three rounds with stable round links and unique winners', async () => {
  const h = await harness();
  try {
    const root = '/admin/events/1';
    await h.write('put', `${root}/rounds`, { rounds: [{ ...celebrationPlan[0], batch_size: 16 }] }).expect(400);
    await h.write('put', `${root}/rounds`, { rounds: celebrationPlan }).expect(200);
    for (let i = 1; i <= 30; i++) {
      const person = await h.add(`Employee ${i}`, `employee${i}@example.com`);
      await h.write('patch', `${root}/people/${person.id}`, { extra_bonus: i % 5 }).expect(200);
    }
    await h.write('patch', root, { ...h.settings, prize_count: 25, status: 'live' }).expect(200);
    const rounds = (await h.admin.get('/api/events/1/public')).body.rounds;
    const selected = [];
    for (const [roundIndex, sizes] of [[0, [5, 5, 5]], [1, [4, 4]], [2, [2]]]) {
      const round = rounds[roundIndex];
      for (const [rollIndex, size] of sizes.entries()) {
        const path = `${root}/rounds/${round.id}/roll`;
        const result = (await h.write('post', path, {}).expect(201)).body;
        selected.push(...result.draws);
        assert.equal(result.winner_count, size);
        assert.equal(result.roll_number, rollIndex + 1);
        assert.ok(result.draws.every(d => d.round_id === round.id));
        assert.ok(new Date(result.draws[0].reveal_at).getTime() >= Date.now() + 9000);
        assert.equal(new Date(result.draws.at(-1).reveal_at) - new Date(result.draws[0].reveal_at), (size - 1) * 12000);
        await h.write('post', path, {}).expect(400);
        if (roundIndex < 2) await h.write('post', `${root}/rounds/${rounds[roundIndex + 1].id}/roll`, {}).expect(400);
        const current = (await h.admin.get('/api/events/1/public')).body;
        assert.equal(current.rounds[roundIndex].awarded_count, sizes.slice(0, rollIndex + 1).reduce((a, b) => a + b, 0));
        assert.equal(Boolean(current.rounds[roundIndex].rolled_at), rollIndex === sizes.length - 1);
        assert.equal(current.stats.eligible_employees, 30 - selected.length);
        await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
        if (roundIndex === 0 && rollIndex === 0) await initialize(h.pool);
      }
    }
    assert.equal(selected.length, 25);
    assert.equal(new Set(selected.map(d => d.person_id)).size, 25);
    const data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.remaining, 0);
    assert.deepEqual(data.rounds.map(r => [r.awarded_count, r.rolls_completed]), [[15, 3], [8, 2], [2, 1]]);
    assert.ok(data.draws.every(d => d.name && d.round_id));
    const csv = (await h.admin.get(`/api${root}/export`).expect(200)).text;
    assert.ok(csv.includes('"Department","Round"'));
    for (const round of celebrationPlan) assert.ok(csv.includes(round.name));
    await h.pool.query('UPDATE events SET is_demo=TRUE WHERE id=1');
    await h.write('post', `${root}/reset-demo`, { confirm: true }).expect(200);
    const reset = (await h.admin.get('/api/events/1/public')).body;
    assert.deepEqual(reset.rounds.map(r => [r.awarded_count, r.rolls_completed, r.rolled_at]), [[null, 0, null], [null, 0, null], [null, 0, null]]);
    assert.equal(reset.remaining, 25);
    assert.equal(reset.stats.eligible_employees, 30);
  } finally { await h.pool.end(); }
});

test('optional departments validate, remain private, and can be edited or cleared by admins', async () => {
  const h = await harness();
  try {
    const person = await h.add('No department', 'optional@another-company.org');
    assert.equal(person.department, '');
    const path = `/admin/events/1/people/${person.id}`;
    const visitor = request.agent(h.app);
    const csrf = (await visitor.get('/api/session')).body.csrf;
    await visitor.patch(`/api${path}`).set('x-csrf-token', csrf).send({ department: 'HR' }).expect(401);
    await h.write('patch', path, { department: ' HR ' }).expect(200);
    assert.equal((await h.admin.get('/api/admin/events/1')).body.people[0].department, 'HR');
    await h.write('patch', path, { department: 'a'.repeat(81) }).expect(400);
    await h.write('patch', path, { department: null }).expect(400);
    await h.write('patch', path, { department: '' }).expect(200);
    assert.equal((await h.admin.get('/api/admin/events/1')).body.people[0].department, '');
    await visitor.post('/api/events/1/signup').set('x-csrf-token', csrf).send({ name: 'Invalid', email: 'invalid@example.com', department: 123 }).expect(400);
    await visitor.post('/api/events/1/signup').set('x-csrf-token', csrf).send({ name: 'Optional', email: 'optional@example.net' }).expect(201);
    assert.equal((await visitor.get('/api/me')).body.person.department, '');
  } finally { await h.pool.end(); }
});

test('a later roll shortage closes its round and reserves only actual future-round prizes', async () => {
  const h = await harness();
  try {
    const root = '/admin/events/1';
    await h.write('put', `${root}/rounds`, { rounds: [
      { name: 'First', prize_label: 'Gift', winner_count: 5, batch_size: 3 },
      { name: 'Final', prize_label: 'Grand gift', winner_count: 2, batch_size: 2 },
    ] }).expect(200);
    for (let n = 1; n <= 4; n++) await h.add(`Employee ${n}`, `shortage${n}@example.com`);
    await h.write('patch', root, { ...h.settings, prize_count: 7, status: 'live' }).expect(200);
    const rounds = (await h.admin.get('/api/events/1/public')).body.rounds;
    await h.write('post', `${root}/rounds/${rounds[0].id}/roll`, {}).expect(201);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
    const second = (await h.write('post', `${root}/rounds/${rounds[0].id}/roll`, {}).expect(201)).body;
    assert.equal(second.requested_count, 2);
    assert.equal(second.winner_count, 1);
    let data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.rounds[0].awarded_count, 4);
    assert.ok(data.rounds[0].rolled_at);
    assert.equal(data.remaining, 2);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
    const last = (await h.write('post', `${root}/rounds/${rounds[1].id}/roll`, {}).expect(201)).body;
    assert.equal(last.winner_count, 0);
    data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.remaining, 0);
    assert.deepEqual(data.rounds.map(r => [r.awarded_count, r.rolls_completed]), [[4, 2], [0, 1]]);
  } finally { await h.pool.end(); }
});

test('celebration migration resets only demo results, seeds 40 demo employees, and is repeat-safe', async () => {
  const h = await harness();
  try {
    await h.write('patch', '/admin/events/1', { ...h.settings, title: 'Real - 5 November 2026' }).expect(200);
    const realPerson = await h.add('Real employee', 'real@example.com');
    const realPeople = (await h.pool.query('SELECT * FROM people WHERE event_id=1')).rows;
    const realTickets = (await h.pool.query('SELECT * FROM tickets WHERE person_id=$1', [realPerson.id])).rows;
    const demo = (await h.write('post', '/admin/events', { ...h.settings, title: 'DEMO ONLY - 5 November 2026' }).expect(201)).body;
    await h.pool.query('UPDATE events SET is_demo=TRUE WHERE id=$1', [demo.id]);
    await h.write('post', `/admin/events/${demo.id}/people`, { name: 'Demo Employee 01', email: 'demo01@example.com' }).expect(201);
    await h.write('put', `/admin/events/${demo.id}/rounds`, { rounds: [{ name: 'Old', prize_label: 'Old prize', winner_count: 1 }] }).expect(200);
    await h.write('patch', `/admin/events/${demo.id}`, { ...h.settings, title: demo.title, prize_count: 1, status: 'live' }).expect(200);
    const round = (await h.admin.get(`/api/events/${demo.id}/public`)).body.rounds[0];
    await h.write('post', `/admin/events/${demo.id}/rounds/${round.id}/roll`, {}).expect(201);
    await assert.rejects(updateCelebrationPlan(h.pool, [1, demo.id]), /finish revealing/);
    assert.equal((await h.admin.get('/api/events/1/public')).body.event.prize_count, 5);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
    const ids = [1, demo.id];
    await updateCelebrationPlan(h.pool, ids);
    const first = (await h.pool.query('SELECT * FROM rounds ORDER BY id')).rows;
    await updateCelebrationPlan(h.pool, ids);
    assert.deepEqual((await h.pool.query('SELECT * FROM rounds ORDER BY id')).rows, first);
    assert.deepEqual((await h.pool.query('SELECT * FROM tickets WHERE person_id=$1', [realPerson.id])).rows, realTickets);
    assert.deepEqual((await h.pool.query('SELECT * FROM people WHERE event_id=1')).rows, realPeople);
    const data = (await h.admin.get(`/api/events/${demo.id}/public`)).body;
    assert.equal(data.stats.participants, 40);
    assert.equal(data.stats.eligible_employees, 40);
    assert.equal(data.event.status, 'live');
    assert.equal(data.draws.length, 0);
    assert.deepEqual(data.rounds.map(r => [r.winner_count, r.batch_size]), [[15, 5], [8, 4], [2, 2]]);
    assert.equal((await h.pool.query("SELECT details FROM audit_log WHERE event_id=$1 AND action='demo.reset'", [demo.id])).rows[0].details.draws.length, 1);
  } finally { await h.pool.end(); }
});
