// Proof suite for ADOPTED RLS (Task #2, phase 2): AsyncLocalStorage tenant
// context + per-query SET LOCAL, exercised through the REAL data layer
// (lib/db-pg q/one/many/withTransaction) — i.e. exactly what the app now does.
//
// Requires Postgres+pgvector. Run:
//   ADMIN_DATABASE_URL=postgres://postgres:test@localhost:5434/satest \
//   node --test scripts/test-rls-adoption.js
//
// Tenant queries run as a NON-SUPERUSER role, because superusers bypass RLS.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ADMIN_URL = process.env.ADMIN_DATABASE_URL || 'postgres://postgres:test@localhost:5434/satest';
const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, '//app_rls:apppw@');
process.env.DB_DRIVER = 'postgres';
process.env.DATABASE_URL = ADMIN_URL;
process.env.RLS_ENABLED = '1'; // exercise the enabled path

const { sql, initDb } = require('../db');
const dbpg = require('../lib/db-pg');
const { runWithContext } = require('../lib/tenant-context');
const { applyRls } = require('../lib/rls');

const A = 'co-a-' + Date.now().toString(36);
const B = 'co-b-' + Date.now().toString(36);

const asTenant = (companyId, fn) => runWithContext({ bypass: false, companyId }, fn);
const asSystem = (fn) => runWithContext({ bypass: true, companyId: null }, fn);

before(async () => {
  await initDb(); // schema as superuser
  const admin = dbpg.getPool();
  const co = (id, name) => sql.insertCompany.run({
    id, user_id: null, name, language: 'ar-SA', voice_id: null,
    phone_number: null, assistant_id: null, system_prompt: '', kb_text: null,
  });
  await co(A, 'Company A'); await co(B, 'Company B');
  const seed = (c, sid, msg) => admin.query(
    'INSERT INTO chats (company_id, session_id, user_message) VALUES ($1,$2,$3)', [c, sid, msg]);
  await seed(A, 'a1', 'A one'); await seed(A, 'a2', 'A two');
  await seed(B, 'b1', 'B one'); await seed(B, 'b2', 'B two'); await seed(B, 'b3', 'B three');

  // Non-superuser app role — RLS only constrains non-superusers.
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_rls') THEN CREATE ROLE app_rls LOGIN PASSWORD 'apppw' NOSUPERUSER; END IF; END $$;");
  await admin.query('GRANT USAGE ON SCHEMA public TO app_rls');
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls');
  await admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls');
  await applyRls(admin);

  // Repoint the app pool at the non-superuser role.
  await dbpg.close();
  process.env.DATABASE_URL = APP_URL;
});

after(async () => { await dbpg.close().catch(() => {}); });

test('tenant A: data layer returns ONLY A (query has no WHERE company_id)', async () => {
  const rows = await asTenant(A, () => dbpg.many('SELECT company_id FROM chats'));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.company_id === A));
});

test('tenant B: returns ONLY B', async () => {
  const rows = await asTenant(B, () => dbpg.many('SELECT company_id FROM chats'));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.company_id === B));
});

test('superadmin/system bypass: sees BOTH tenants', async () => {
  const rows = await asSystem(() => dbpg.many('SELECT company_id FROM chats'));
  const ids = new Set(rows.map((r) => r.company_id));
  assert.ok(ids.has(A) && ids.has(B), 'bypass reads across tenants');
});

test('no context at all: fail-closed, zero rows (the DB is the enforcer)', async () => {
  const rows = await dbpg.many('SELECT company_id FROM chats');
  assert.equal(rows.length, 0);
});

test('cross-tenant read blocked: A cannot fetch a known B row by id', async () => {
  const b = await asTenant(B, () => dbpg.one('SELECT id FROM chats LIMIT 1'));
  const seen = await asTenant(A, () => dbpg.many('SELECT id FROM chats WHERE id = $1', [b.id]));
  assert.equal(seen.length, 0);
});

test('cross-tenant write blocked (WITH CHECK)', async () => {
  await assert.rejects(
    () => asTenant(A, () => dbpg.q(
      'INSERT INTO chats (company_id, session_id, user_message) VALUES ($1,$2,$3)', [B, 'x', 'sneaky'])),
    /row-level security|policy/i,
  );
});

test('context does NOT leak to the next pooled query (SET LOCAL discarded)', async () => {
  await asTenant(A, () => dbpg.many('SELECT 1 FROM chats'));   // borrow + release with context
  const rows = await dbpg.many('SELECT company_id FROM chats'); // same pool, no context
  assert.equal(rows.length, 0, 'no context leakage across pooled connections');
});

test('withTransaction inherits the tenant context', async () => {
  const rows = await asTenant(A, () => dbpg.withTransaction(
    async (c) => (await c.query('SELECT company_id FROM chats')).rows));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.company_id === A));
});

test('worker/webhook (system bypass) can write for any tenant', async () => {
  await asSystem(() => dbpg.q(
    'INSERT INTO chats (company_id, session_id, user_message) VALUES ($1,$2,$3)', [B, 'sys', 'from worker']));
  const rows = await asTenant(B, () => dbpg.many('SELECT company_id FROM chats'));
  assert.equal(rows.length, 4, 'worker-written row is visible to its tenant');
});
