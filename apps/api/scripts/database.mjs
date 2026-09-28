// PGlite has one connection. Serialize leases so API transactions and legacy RPCs
// share the same connection boundary in local integration tests.
export function databasePool(db) {
  let queue = Promise.resolve();
  const pool = {
    on() {},
    async end() {},
    async connect() {
      const previous = queue;
      let release;
      queue = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      return {
        async query(text, params) {
          const result = await db.query(text, params);
          return {
            ...result,
            rowCount: result.rows.length || result.affectedRows,
          };
        },
        release,
      };
    },
    async query(text, params) {
      const client = await pool.connect();
      try {
        return await client.query(text, params);
      } finally {
        client.release();
      }
    },
  };
  return pool;
}
