import 'dotenv/config';
import pg from 'pg';
import { initialize } from './lib/database.js';
import { createApp } from './lib/app.js';

const required = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key}. See .env.example.`);
}
if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters.');
if (process.env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must have at least 12 characters.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000 });
pool.on('error', error => console.error('Database pool error:', error.message));
await initialize(pool);
const app = createApp({ pool, config: {
  sessionSecret: process.env.SESSION_SECRET,
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  production: process.env.NODE_ENV === 'production',
} });
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`Lucky Draw listening on port ${process.env.PORT || 3000}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
}
