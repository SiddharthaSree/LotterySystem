import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { initialize } from '../lib/database.js';
import { updateDiwali2026 } from '../scripts/update-diwali-2026.js';
import { diwaliTasks, DIWALI_SIGNUP_CUTOFF } from '../lib/diwali-2026.js';

const legacy = ['Appreciate a colleague', 'Share a positive experience', 'Join the Diwali quiz',
  'Dress in ethnic wear', 'Join a team activity', 'Share an engagement idea'];

async function prepareLegacy(h, eventId) {
  const { rows: tasks } = await h.pool.query('SELECT * FROM tasks WHERE event_id=$1 ORDER BY id', [eventId]);
  for (const [index, title] of legacy.entries()) {
    if (index < tasks.length) {
      await h.pool.query('UPDATE tasks SET title=$2,description=$3 WHERE id=$1', [tasks[index].id, title, 'Old schedule']);
    } else await h.pool.query('INSERT INTO tasks(event_id,title,description) VALUES($1,$2,$3)', [eventId, title, 'Old schedule']);
  }
  await h.pool.query('UPDATE events SET bonus_cap=5 WHERE id=$1', [eventId]);
  return (await h.pool.query('SELECT * FROM tasks WHERE event_id=$1 ORDER BY id', [eventId])).rows;
}

test('new events use four Diwali activities, five-ticket maximum, and independent signup deadline', async () => {
  const h = await harness();
  try {
    const data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.event.bonus_cap, 4);
    assert.deepEqual(data.tasks.map(task => [task.title, task.description]), diwaliTasks);
    const { rows: [defaults] } = await h.pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='events' AND column_name='bonus_cap'");
    assert.equal(defaults.column_default, '4');
    assert.equal(new Date(DIWALI_SIGNUP_CUTOFF).toISOString(), '2026-11-05T00:30:00.000Z');
    const person = await h.add('All Activities', 'all@example.com');
    for (const task of data.tasks) await h.write('put', `/admin/events/1/people/${person.id}/tasks/${task.id}`, { done: true }).expect(200);
    const tickets = (await h.pool.query('SELECT * FROM tickets WHERE person_id=$1 AND active=TRUE', [person.id])).rows;
    assert.equal(tickets.length, 5);
    await h.write('put', `/admin/events/1/people/${person.id}/tasks/${data.tasks[2].id}`, { done: true }).expect(200);
    assert.equal((await h.pool.query('SELECT * FROM tickets WHERE person_id=$1 AND active=TRUE', [person.id])).rows.length, 5);
  } finally { await h.pool.end(); }
});

test('schedule migration is atomic and repeat-safe, keeps awards and IDs, and requires re-verifying quiz wins', async () => {
  const h = await harness();
  try {
    const tasks = await prepareLegacy(h, 1);
    const demo = (await h.write('post', '/admin/events', {
      ...h.settings, title: 'DEMO ONLY - Reusable 15-Employee Showcase',
    }).expect(201)).body;
    await h.pool.query('UPDATE events SET is_demo=TRUE WHERE id=$1', [demo.id]);
    await prepareLegacy(h, demo.id);
    const other = (await h.write('post', '/admin/events', { ...h.settings, title: 'Unrelated event' }).expect(201)).body;
    const untouched = (await h.pool.query('SELECT * FROM events WHERE id=$1', [other.id])).rows;
    const person = await h.add('Existing Employee', 'existing@example.com');
    for (const task of tasks) await h.write('put', `/admin/events/1/people/${person.id}/tasks/${task.id}`, { done: true }).expect(200);
    const before = (await h.pool.query('SELECT * FROM tickets WHERE person_id=$1 ORDER BY id', [person.id])).rows;
    assert.equal(before.filter(ticket => ticket.active).length, 6);
    const eventBefore = (await h.pool.query('SELECT * FROM events WHERE id=1')).rows;
    await assert.rejects(updateDiwali2026(h.pool, [1, 999]), /not found/);
    assert.deepEqual((await h.pool.query('SELECT * FROM events WHERE id=1')).rows, eventBefore);
    assert.equal((await h.pool.query("SELECT * FROM audit_log WHERE action='event.diwali_2026_rescheduled'")).rows.length, 0);
    await h.write('put', '/admin/events/1/rounds', { rounds: [{ name: 'Final', prize_label: 'Gift', winner_count: 1 }] }).expect(200);
    await h.write('patch', '/admin/events/1', { ...h.settings, prize_count: 1, bonus_cap: 5, status: 'live' }).expect(200);
    const plan = (await h.admin.get('/api/events/1/public')).body.rounds[0];
    await h.write('post', `/admin/events/1/rounds/${plan.id}/roll`, {}).expect(201);
    await assert.rejects(updateDiwali2026(h.pool, [1, demo.id]), /finish revealing/);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE event_id=1");
    const draws = (await h.pool.query('SELECT * FROM draws ORDER BY id')).rows;
    const rounds = (await h.pool.query('SELECT * FROM rounds ORDER BY id')).rows;
    await updateDiwali2026(h.pool, [1, demo.id]);
    let data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.event.status, 'live');
    assert.equal(data.event.bonus_cap, 4);
    assert.equal(data.event.signup_closes_at, '2026-11-05T00:30:00.000Z');
    assert.ok(data.event.title.includes('5 November 2026'));
    assert.deepEqual(data.tasks.map(task => task.id), tasks.slice(0, 4).map(task => task.id));
    assert.deepEqual(data.tasks.map(task => [task.title, task.description]), diwaliTasks);
    assert.equal(data.stats.tickets, 0, 'Winners remain excluded');
    assert.deepEqual((await h.pool.query('SELECT * FROM draws ORDER BY id')).rows, draws);
    assert.deepEqual((await h.pool.query('SELECT * FROM rounds ORDER BY id')).rows, rounds);
    assert.deepEqual((await h.pool.query('SELECT * FROM events WHERE id=$1', [other.id])).rows, untouched);
    const after = (await h.pool.query('SELECT * FROM tickets WHERE person_id=$1 ORDER BY id', [person.id])).rows;
    assert.deepEqual(after.map(ticket => ticket.id), before.map(ticket => ticket.id));
    assert.equal(after.filter(ticket => ticket.active).length, 4);
    assert.equal((await h.pool.query('SELECT done FROM completions WHERE person_id=$1 AND task_id=$2', [person.id, tasks[2].id])).rows[0].done, false);
    await h.write('put', `/admin/events/1/people/${person.id}/tasks/${tasks[2].id}`, { done: true }).expect(200);
    assert.equal((await h.pool.query('SELECT * FROM tickets WHERE person_id=$1 AND active=TRUE', [person.id])).rows.length, 5);
    await h.pool.query("UPDATE tasks SET description='PM customized instructions' WHERE id=$1", [tasks[0].id]);
    await updateDiwali2026(h.pool, [1, demo.id]);
    await initialize(h.pool);
    data = (await h.admin.get('/api/events/1/public')).body;
    assert.equal(data.tasks[0].description, 'PM customized instructions');
    const logs = (await h.pool.query("SELECT details FROM audit_log WHERE action='event.diwali_2026_rescheduled' ORDER BY event_id")).rows;
    assert.equal(logs.length, 2);
    assert.deepEqual(logs[0].details.previousTickets.map(ticket => String(ticket.id)).sort(), before.map(ticket => String(ticket.id)).sort());
    assert.equal(logs[0].details.previousTasks.length, 6);
  } finally { await h.pool.end(); }
});
