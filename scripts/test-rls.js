// Proof suite for PostgreSQL Row-Level Security tenant isolation (Task #2).
// Requires a Postgres+pgvector at DATABASE_URL (default local container on 5433).
// Run: DATABASE_URL=postgres://postgres:test@localhost:5433/satest node --test scripts/test-rls.js
//
// Uses a dedicated NON-SUPERUSER role for the tenant queries, because superusers
// bypass RLS — this also mirrors the required production setup.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://postgres:test@localhost:5434/satest';
process.env.DB_DRIVER = 'postgres';
process.env.DATABASE_URL = ADMIN_URL;

const { sql, initDb } = require('../db');
const dbpg = require('../lib/db-pg');
const { applyRls, TENANT_TABLES } = require('../lib/rls');

const A = 'co-a-' + Date.now().toString(36);
const B = 'co-b-' + Date.now().toString(36);
const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, '//app_rls:apppw@');

let appPool;
const rows = (res) => res.rows;

// Tenant-scoped runner bound to a pool (mirrors db-pg.withTenant exactly).
async function asTenant(pool, companyId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_company', $1, true)", [String(companyId)]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); }
}

before(async () => {
  await initDb();
  const admin = dbpg.getPool();
  // companies has no RLS — create the two tenants
  const co = (id, name) => sql.insertCompany.run({ id, user_id: null, name, language: 'ar-SA', voice_id: null, phone_number: null, assistant_id: null, system_prompt: '', kb_text: null });
  await co(A, 'Company A'); await co(B, 'Company B');
  // seed chats (superuser, before RLS is relevant)
  const seed = (c, sid, msg) => admin.query('INSERT INTO chats (company_id, session_id, user_message) VALUES ($1,$2,$3)', [c, sid, msg]);
  await seed(A, 's-a1', 'A one'); await seed(A, 's-a2', 'A two');
  await seed(B, 's-b1', 'B one'); await seed(B, 's-b2', 'B two'); await seed(B, 's-b3', 'B three');
  // non-superuser app role (superusers bypass RLS)
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_rls') THEN CREATE ROLE app_rls LOGIN PASSWORD 'apppw' NOSUPERUSER; END IF; END $$;");
  await admin.query('GRANT USAGE ON SCHEMA public TO app_rls');
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls');
  await admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls');
  const applied = await applyRls(admin);
  assert.ok(applied.includes('chats'), 'RLS applied to chats');
  appPool = new Pool({ connectionString: APP_URL });
});

after(async () => {
  if (appPool) await appPool.end().catch(() => {});
  await dbpg.close().catch(() => {});
});

test('tenant A: filter-less SELECT returns ONLY company A rows', async () => {
  const r = await asTenant(appPool, A, (c) => c.query('SELECT company_id FROM chats').then(rows));
  assert.equal(r.length, 2, 'A sees exactly its 2 rows');
  assert.ok(r.every((x) => x.company_id === A));
});

test('tenant B: filter-less SELECT returns ONLY company B rows', async () => {
  const r = await asTenant(appPool, B, (c) => c.query('SELECT company_id FROM chats').then(rows));
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.company_id === B));
});

test('no tenant context: filter-less SELECT returns ZERO rows (fail-closed)', async () => {
  const r = await appPool.query('SELECT company_id FROM chats');
  assert.equal(r.rows.length, 0, 'without context the DB returns nothing, never everything');
});

test('cross-tenant read blocked: A cannot fetch a specific B row by id', async () => {
  const bid = await asTenant(appPool, B, (c) => c.query('SELECT id FROM chats LIMIT 1').then((r) => r.rows[0].id));
  const seen = await asTenant(appPool, A, (c) => c.query('SELECT id FROM chats WHERE id = $1', [bid]).then(rows));
  assert.equal(seen.length, 0, 'A gets 0 rows for a known B id');
});

test('write blocked: A cannot INSERT a row tagged company B (WITH CHECK)', async () => {
  await assert.rejects(
    () => asTenant(appPool, A, (c) => c.query('INSERT INTO chats (company_id, session_id, user_message) VALUES ($1,$2,$3)', [B, 's-x', 'sneaky'])),
    /row-level security|policy/i,
  );
});

test('normal ops still work: A inserts + reads its own rows', async () => {
  await asTenant(appPool, A, (c) => c.query('INSERT INTO chats (company_id, session_id, user_message) VALUES ($1,$2,$3)', [A, 's-a3', 'legit']));
  const r = await asTenant(appPool, A, (c) => c.query('SELECT company_id FROM chats').then(rows));
  assert.equal(r.length, 3, 'A now sees its 3 rows (2 seeded + 1 new)');
  assert.ok(r.every((x) => x.company_id === A));
});

test('all tenant tables have RLS enabled + forced', async () => {
  const r = await dbpg.q('SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)', [TENANT_TABLES]);
  const by = Object.fromEntries(r.rows.map((x) => [x.relname, x]));
  for (const t of ['chats', 'calls', 'kb_chunks', 'scenarios', 'api_keys', 'campaigns']) {
    assert.ok(by[t] && by[t].relrowsecurity, `${t}: RLS enabled`);
    assert.ok(by[t] && by[t].relforcerowsecurity, `${t}: RLS forced`);
  }
});
