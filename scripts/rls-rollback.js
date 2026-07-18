// EMERGENCY ROLLBACK for Row-Level Security (Task #2).
//
// Drops the tenant policies and disables RLS, so the application works whether
// or not it is setting a tenant context. Pair with RLS_ENABLED=0 on the app.
//
// Usage (run as the table OWNER / admin role, not the app role):
//   DATABASE_URL=postgres://<admin>@host/db node scripts/rls-rollback.js
//
// This is idempotent and safe to run at any time.
require('dotenv').config();
const { getPool, close } = require('../lib/db-pg');
const { TENANT_TABLES } = require('../lib/rls');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — RLS is Postgres-only.');
    process.exit(1);
  }
  const pool = getPool();
  const done = [];
  try {
    for (const t of TENANT_TABLES) {
      const reg = await pool.query('SELECT to_regclass($1) AS reg', [t]);
      if (!reg.rows[0].reg) continue;
      await pool.query(`
        ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON ${t};
      `);
      done.push(t);
    }
    console.log(`RLS DISABLED on ${done.length} table(s): ${done.join(', ')}`);
    console.log('Next: set RLS_ENABLED=0 (or remove it) so the app skips the tenant-context path.');
  } catch (e) {
    console.error('rollback error:', e.message);
    process.exit(1);
  } finally {
    await close();
  }
})();
