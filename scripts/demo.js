import { randomBytes } from 'node:crypto';
import session from 'express-session';
import { localPool } from './local-pool.js';
import { initialize } from '../lib/database.js';
import { createApp } from '../lib/app.js';

const pool = await localPool('.demo-data');
await initialize(pool);
const password = randomBytes(12).toString('base64url');
const app = createApp({ pool, sessionStore: new session.MemoryStore(), config: {
  sessionSecret: randomBytes(32).toString('hex'), adminEmail: 'admin@demo.local', adminPassword: password, production: false,
} });
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`LOCAL DEMO ONLY: http://127.0.0.1:${port}`);
  console.log('Admin email: admin@demo.local');
  console.log(`Temporary admin password: ${password}`);
  console.log('Data persists in .demo-data. Sessions and the temporary password reset on restart.');
  console.log('Production uses external PostgreSQL and the credentials in your environment.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
}
