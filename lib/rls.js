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
  // Publish history carries a real company_id and is surfaced per company, so
  // it is policed like tenant data rather than treated as a platform log. The
  // admin routes that write it run under the system bypass, so this costs
  // nothing there and fails closed everywhere else.
  'company_publish_runs',
  // Capability configuration and the provider tool ids backing it. Both are
  // per-tenant: which capabilities a company has is its own business, and a
  // tool id is the handle to a resource that answers with that tenant's data.
  'company_features', 'company_tools',
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

/**
 * Arm only the tenant tables Postgres is NOT already policing.
 *
 * Exists because adding a tenant table used to mean remembering to re-run
 * scripts/rls-migrate.js by hand. Nobody does, so a new table ships with the
 * application filter in place but no database backstop, and /health quietly
 * reports fewer enforced tables than TENANT_TABLES lists — which is exactly
 * how company_features and company_tools reached production unprotected.
 *
 * Only touches tables that exist and lack rowsecurity, so a steady-state boot
 * does no writes at all. The caller decides whether to run it; it is gated on
 * an explicit opt-in so a deployment that has not rolled RLS out is untouched.
 *
 * @returns {Promise<string[]>} the tables newly armed (empty on a healthy boot)
 */
async function armMissingRls(runner, { tables = TENANT_TABLES } = {}) {
  const res = await runner.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND rowsecurity = true AND tablename = ANY($1)`,
    [tables],
  );
  const already = new Set(res.rows.map((r) => r.tablename));
  const missing = tables.filter((t) => !already.has(t));
  if (!missing.length) return [];
  return applyRls(runner, { tables: missing });
}

module.exports = { TENANT_TABLES, policySql, applyRls, armMissingRls };
