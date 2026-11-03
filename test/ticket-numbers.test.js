import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { harness } from './helpers.js';
import { initialize } from '../lib/database.js';

test('ticket numbers are unique six-digit random values, stable through allocation edits and demo reset', async () => {
  const h = await harness();
  try {
    const people = [];
    for (let i = 0; i < 20; i++) people.push(await h.add(`Number Test ${i}`, `numbers${i}@example.com`));
    for (let i = 0; i < people.length; i += 4) {
      await Promise.all(people.slice(i, i + 4).map(person =>
        h.write('patch', `/admin/events/1/people/${person.id}`, { extra_bonus: 4 }).expect(200)));
    }
    const tickets = (await h.pool.query('SELECT * FROM tickets ORDER BY id')).rows;
    assert.equal(tickets.length, 100);
    assert.equal(new Set(tickets.map(ticket => ticket.ticket_number)).size, 100);
    assert.ok(tickets.every(ticket => /^[1-9]\d{5}$/.test(String(ticket.ticket_number))));
    assert.ok(tickets.some((ticket, i) => i && ticket.ticket_number < tickets[i - 1].ticket_number), 'Numbers are not an increasing sequence');
    const person = people[0];
    await h.write('patch', `/admin/events/1/people/${person.id}`, { extra_bonus: 0 }).expect(200);
    await h.write('patch', `/admin/events/1/people/${person.id}`, { extra_bonus: 4 }).expect(200);
    assert.deepEqual((await h.pool.query('SELECT * FROM tickets ORDER BY id')).rows, tickets);
    await h.write('patch', '/admin/events/1', { ...h.settings, status: 'live' }).expect(200);
    const draw = (await h.write('post', '/admin/events/1/draw', {}).expect(201)).body.draws[0];
    const selected = tickets.find(ticket => String(ticket.id) === String(draw.ticket_id));
    assert.equal(draw.ticket_number, selected.ticket_number);
    const employee = request.agent(h.app);
    const csrf = (await employee.get('/api/session')).body.csrf;
    await employee.post('/api/events/1/login').set('x-csrf-token', csrf).send({ email: people.find(p => p.id === draw.person_id).email }).expect(200);
    let me = (await employee.get('/api/me')).body;
    assert.equal(me.winning_ticket_number, null);
    assert.ok(me.tickets.some(ticket => ticket.ticket_number === draw.ticket_number));
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
    const data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.draws[0].ticket_number, draw.ticket_number);
    me = (await employee.get('/api/me')).body;
    assert.equal(me.winning_ticket_number, draw.ticket_number);
    const csv = await h.admin.get('/api/admin/events/1/export').expect(200);
    assert.ok(csv.text.includes(`CSI-${draw.ticket_number}`));
    await h.pool.query('UPDATE events SET is_demo=TRUE WHERE id=1');
    await h.write('post', '/admin/events/1/reset-demo', { confirm: true }).expect(200);
    await initialize(h.pool);
    assert.deepEqual((await h.pool.query('SELECT * FROM tickets ORDER BY id')).rows, tickets);
    await assert.rejects(h.pool.query('UPDATE tickets SET ticket_number=$1 WHERE id=$2', [tickets[0].ticket_number, tickets[1].id]), /unique/i);
    await assert.rejects(h.pool.query('UPDATE tickets SET ticket_number=99999 WHERE id=$1', [tickets[0].id]), /check/i);
    await assert.rejects(h.pool.query('UPDATE tickets SET ticket_number=NULL WHERE id=$1', [tickets[0].id]), /null/i);
  } finally { await h.pool.end(); }
});

test('legacy tickets receive audited display numbers once without changing draw references', async () => {
  const h = await harness();
  try {
    const person = await h.add('Legacy Winner', 'legacy-number@example.com');
    await h.write('patch', '/admin/events/1', { ...h.settings, status: 'live' }).expect(200);
    await h.write('post', '/admin/events/1/draw', {}).expect(201);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
    const draws = (await h.pool.query('SELECT * FROM draws ORDER BY id')).rows;
    const tickets = (await h.pool.query('SELECT id,person_id,source_key,active FROM tickets ORDER BY id')).rows;
    await h.pool.query('ALTER TABLE tickets DROP COLUMN ticket_number');
    await initialize(h.pool);
    const numbered = (await h.pool.query('SELECT * FROM tickets ORDER BY id')).rows;
    assert.ok(numbered.every(ticket => ticket.ticket_number >= 100000 && ticket.ticket_number <= 999999));
    assert.deepEqual(numbered.map(ticket => ({
      id: ticket.id, person_id: ticket.person_id, source_key: ticket.source_key, active: ticket.active,
    })), tickets);
    assert.deepEqual((await h.pool.query('SELECT * FROM draws ORDER BY id')).rows, draws);
    const logs = (await h.pool.query("SELECT details FROM audit_log WHERE event_id=1 AND action='tickets.random_numbers_assigned'")).rows;
    assert.equal(logs.length, 1);
    assert.equal(String(logs[0].details.tickets[0].ticketId), String(tickets[0].id));
    await initialize(h.pool);
    assert.deepEqual((await h.pool.query('SELECT * FROM tickets ORDER BY id')).rows, numbered);
    assert.equal((await h.admin.get('/api/events/1/public')).body.draws[0].ticket_number, numbered[0].ticket_number);
    assert.equal(numbered[0].person_id, person.id);
  } finally { await h.pool.end(); }
});
