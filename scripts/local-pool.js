import { PGlite } from '@electric-sql/pglite';

// PGlite has one connection; serialize access so test/demo transactions cannot interleave.
export async function localPool(dataDir) {
  const db = new PGlite(dataDir);
  await db.waitReady;
  let tail = Promise.resolve();
  const connect = async () => {
    const previous = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    return {
      query: async (sql, params) => {
        if (params?.length) return db.query(sql, params);
        const results = await db.exec(sql);
        return results.at(-1) || { rows: [] };
      },
      release: unlock,
    };
  };
  return {
    connect,
    async query(sql, params) {
      const client = await connect();
      try { return await client.query(sql, params); }
      finally { client.release(); }
    },
    async end() { await tail; await db.close(); },
  };
}
