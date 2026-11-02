import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { harness } from './helpers.js';

test('round plans lock on Live and sequential rolls exclude winners, tolerate shortages, and cannot repeat', async () => {
  const h = await harness();
  try {
    const root = '/admin/events/1';
    const plan = [
      { name: 'Round 1', prize_label: 'Hamper', winner_count: 2 },
      { name: 'Round 2', prize_label: 'Voucher', winner_count: 3 },
      { name: 'Round 3', prize_label: 'Surprise', winner_count: 2 },
    ];
    for (const invalid of [[], [null], [{ ...plan[0], winner_count: 0 }], [{ ...plan[0], winner_count: 1001 }], [plan[0], { ...plan[0], winner_count: 1000 }]]) {
      await h.write('put', `${root}/rounds`, { rounds: invalid }).expect(400);
    }
    await h.write('put', `${root}/rounds`, { rounds: plan }).expect(200);
    let data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.event.prize_count, 7);
    const rounds = data.rounds;
    assert.equal(rounds.length, 3);
    await h.write('post', `${root}/rounds/${rounds[0].id}/roll`, {}).expect(400);
    for (let i = 1; i <= 4; i++) await h.add(`Round Employee ${i}`, `round${i}@example.com`);
    const auth = request.agent(h.app);
    const csrf = (await auth.get('/api/session')).body.csrf;
    await auth.post(`/api${root}/rounds/${rounds[0].id}/roll`).set('x-csrf-token', csrf).send({}).expect(401);
    await h.admin.post(`/api${root}/rounds/${rounds[0].id}/roll`).send({}).expect(403);
    await h.write('patch', root, { ...h.settings, prize_count: 7, status: 'live' }).expect(200);
    await h.write('put', `${root}/rounds`, { rounds: plan }).expect(400);
    await h.write('patch', root, { ...h.settings, prize_count: 7, status: 'open' }).expect(200);
    await h.write('put', `${root}/rounds`, { rounds: plan }).expect(400);
    await h.write('patch', root, { ...h.settings, prize_count: 7, status: 'live' }).expect(200);
    await h.write('patch', root, { ...h.settings, prize_count: 8, status: 'live' }).expect(400);
    await h.write('post', `${root}/draw`, { winner_count: 1 }).expect(400);
    await h.write('post', `${root}/rounds/${rounds[1].id}/roll`, {}).expect(400);
    const attempts = await Promise.all([
      h.write('post', `${root}/rounds/${rounds[0].id}/roll`, { winner_count: 999, prize_label: 'Tampered' }),
      h.write('post', `${root}/rounds/${rounds[0].id}/roll`, {}),
    ]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [201, 400]);
    const first = attempts.find(r => r.status === 201).body;
    assert.equal(first.winner_count, 2);
    assert.ok(first.draws.every(d => d.prize_label === 'Hamper'));
    await h.write('post', `${root}/rounds/${rounds[1].id}/roll`, {}).expect(400);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE event_id=1");
    const second = (await h.write('post', `${root}/rounds/${rounds[1].id}/roll`, {}).expect(201)).body;
    assert.equal(second.requested_count, 3);
    assert.equal(second.winner_count, 2);
    assert.equal(second.reduced, true);
    assert.equal(new Set([...first.draws, ...second.draws].map(d => d.person_id)).size, 4);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE event_id=1");
    const third = (await h.write('post', `${root}/rounds/${rounds[2].id}/roll`, {}).expect(201)).body;
    assert.equal(third.winner_count, 0);
    assert.equal(third.reduced, true);
    data = (await h.admin.get('/api/events/1/public')).body;
    assert.deepEqual(data.rounds.map(r => r.awarded_count), [2, 2, 0]);
    assert.ok(data.rounds.every(r => r.rolled_at));
    assert.equal(data.remaining, 0);
    assert.equal(data.stats.tickets, 0);
    await h.write('post', `${root}/rounds/${rounds[2].id}/roll`, {}).expect(400);
    const fresh = await h.add('Late after rounds', 'late-round@example.com');
    assert.ok(fresh.approved);
    await h.write('post', `${root}/rounds/${rounds[2].id}/roll`, {}).expect(400);
    await h.write('patch', root, { ...h.settings, prize_count: 7, status: 'ended' }).expect(200);
  } finally { await h.pool.end(); }
});

test('events with existing draws cannot acquire a round plan; manual events remain available', async () => {
  const h = await harness();
  try {
    await h.add('Existing Winner', 'existing@example.com');
    await h.write('patch', '/admin/events/1', { ...h.settings, status: 'live' }).expect(200);
    await h.write('post', '/admin/events/1/draw', {}).expect(201);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE event_id=1");
    await h.write('patch', '/admin/events/1', { ...h.settings, status: 'open' }).expect(200);
    await h.write('put', '/admin/events/1/rounds', { rounds: [{ name: 'Later', prize_label: 'Gift', winner_count: 1 }] }).expect(400);
  } finally { await h.pool.end(); }
});
