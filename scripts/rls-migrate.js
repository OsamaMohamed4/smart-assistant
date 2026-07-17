// Apply Row-Level Security policies to the tenant tables (Task #2).
//
// Usage: DATABASE_URL=postgres://... node scripts/rls-migrate.js
//
// ── ADOPTION NOTES (read before enabling in production) ─────────────────────
// 1. RLS only protects when the APP connects as a NON-SUPERUSER role — a
//    superuser bypasses RLS. Create a dedicated role and point DATABASE_URL at it:
//       CREATE ROLE app_rw LOGIN PASSWORD '...' NOSUPERUSER;
//       GRANT USAGE ON SCHEMA public TO app_rw;
//       GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
//       GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
// 2. Once enabled, every tenant-scoped query MUST run through
//    db-pg.withTenant(companyId, fn) or it returns zero rows (fail-closed).
// 3. Superadmin / cross-tenant jobs need a BYPASSRLS role or their own context.
// This script is idempotent and safe to re-run.
require('dotenv').config();
const { getPool, close } = require('../lib/db-pg');
const { applyRls, TENANT_TABLES } = require('../lib/rls');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — RLS is Postgres-only.');
    process.exit(1);
  }
  try {
    const applied = await applyRls(getPool());
    console.log(`RLS applied to ${applied.length}/${TENANT_TABLES.length} tenant tables:`);
    console.log('  ' + applied.join(', '));
    const skipped = TENANT_TABLES.filter((t) => !applied.includes(t));
    if (skipped.length) console.log('  (skipped — not present: ' + skipped.join(', ') + ')');
  } catch (e) {
    console.error('RLS migrate error:', e.message);
    process.exit(1);
  } finally {
    await close();
  }
})();
