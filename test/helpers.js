import session from 'express-session';
import request from 'supertest';
import { localPool } from '../scripts/local-pool.js';
import { initialize } from '../lib/database.js';
import { createApp } from '../lib/app.js';

export async function harness() {
  const pool = await localPool();
  await initialize(pool);
  const config = { sessionSecret: 'test-secret-with-more-than-thirty-two-characters',
    adminEmail: 'admin@example.com', adminPassword: 'a-test-password-for-admin', production: false };
  const app = createApp({ pool, config, sessionStore: new session.MemoryStore() });
  const admin = request.agent(app);
  let csrf = (await admin.get('/api/session')).body.csrf;
  const login = await admin.post('/api/admin/login').set('x-csrf-token', csrf).send({ email: config.adminEmail, password: config.adminPassword });
  if (login.status !== 200) throw new Error(JSON.stringify(login.body));
  csrf = login.body.csrf;
  const write = (method, path, body) => admin[method](`/api${path}`).set('x-csrf-token', csrf).send(body);
  const event = (await admin.get('/api/events/1/public')).body.event;
  const settings = { ...event, signup_closes_at: '2099-11-04T06:00:00+05:30' };
  await write('patch', '/admin/events/1', settings).expect(200);
  const add = async (name, email) => {
    await write('post', '/admin/events/1/people', { name, email }).expect(201);
    return (await admin.get('/api/admin/events/1')).body.people.find(p => p.email === email);
  };
  return { app, pool, config, admin, write, settings, add };
}
