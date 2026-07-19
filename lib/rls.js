// PostgreSQL Row-Level Security for tenant isolation (Task #2).
//
// Each tenant table is filtered by a per-transaction setting `app.current_company`,
// set through db-pg.withTenant(). FORCE ROW LEVEL SECURITY makes the policy apply
// even to the table owner, so a forgotten `WHERE company_id = ?` can no longer
// leak across tenants — Postgres itself refuses the rows.
//
// Fail-closed: current_setting('app.current_company', true) is NULL when unset,
// so a query with no tenant context returns ZERO rows (never everything).
//
// IMPORTANT: superusers bypass RLS unconditionally. The application MUST connect
// as a NON-superuser role for these policies to protect anything (see
// scripts/rls-migrate.js notes).

// Every table carrying a direct company_id that holds tenant data.
//
// NOT included, deliberately:
//   users            — the login path queries it BEFORE any tenant context
//                      exists; a policy here would lock everyone out.
//   companies        — the tenant registry itself; superadmin aggregates and
//                      the pre-auth public company lookup both need it.
//   sessions/auth_events/audit_events/webhook_events/schema_migrations
//                    — platform tables, not tenant-owned.
//
// campaign_contacts and scenario_versions gained a denormalized company_id in
// lib/migrations-pg.js precisely so they could be policed here — the first
// holds customer phone numbers and was the most sensitive gap (audit F-05).
const TENANT_TABLES = [
  'chats', 'calls', 'kb_documents', 'kb_chunks', 'usage_counters',
  'scenarios', 'api_keys', 'campaigns', 'eval_questions', 'eval_runs',
  'whatsapp_sessions', 'campaign_contacts', 'scenario_versions',
];

function policySql(table) {
  return `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON ${table};
    CREATE POLICY tenant_isolation ON ${table}
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR company_id = current_setting('app.current_company', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR company_id = current_setting('app.current_company', true)
      );
  `;
}

// runner = anything with .query (a pg Pool or Client). Idempotent; skips tables
// that don't exist in this deployment.
async function applyRls(runner, { tables = TENANT_TABLES } = {}) {
  const applied = [];
  for (const t of tables) {
    const reg = await runner.query('SELECT to_regclass($1) AS reg', [t]);
    if (!reg.rows[0].reg) continue;
    await runner.query(policySql(t));
    applied.push(t);
  }
  return applied;
}

module.exports = { TENANT_TABLES, policySql, applyRls };
