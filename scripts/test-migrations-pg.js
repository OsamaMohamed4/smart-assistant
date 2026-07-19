// Proof suite for the PostgreSQL schema-drift fix (audit F-03/F-05).
//
// Verifies that boot-time migrations:
//   1. add every foreign key the SQLite schema has
//   2. clean pre-existing orphan rows instead of failing
//   3. cascade deletes (the actual bug: DELETE FROM companies orphaned data)
//   4. add + backfill the denormalized company_id columns RLS needs
//   5. are idempotent — a second boot changes nothing
//
//   DATABASE_URL=postgres://postgres:test@localhost:5445/satest \
//   node --use-system-ca --test scripts/test-migrations-pg.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_DRIVER = 'postgres';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:test@localhost:5445/satest';

const { getPool, close } = require('../lib/db-pg');
const { FOREIGN_KEYS } = require('../lib/migrations-pg');

let pool;
const q = (t, p) => pool.query(t, p);

before(async () => {
  pool = getPool();
  await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await q('CREATE EXTENSION IF NOT EXISTS vector');

  // Boot once to create the schema, but WITHOUT migrations, so we can seed
  // orphans that mimic a real production database predating the FKs.
  const { DDL } = require('../db-pg-schema');
  await q(DDL);

  await q(`INSERT INTO companies (id, name, language, system_prompt) VALUES ('co-live', 'Live Co', 'ar-SA', '')`);
  await q(`INSERT INTO chats (company_id, session_id, user_message) VALUES ('co-live', 's1', 'hello')`);
  // Orphans: rows whose parent does not exist. Adding an FK over these fails
  // unless the migration cleans them first.
  await q(`INSERT INTO chats (company_id, session_id, user_message) VALUES ('co-GONE', 's2', 'orphan')`);
  await q(`INSERT INTO calls (id, company_id) VALUES ('call-orphan', 'co-GONE')`);
  await q(`INSERT INTO campaigns (id, company_id, name) VALUES (900, 'co-live', 'C')`);
  await q(`INSERT INTO campaign_contacts (campaign_id, phone) VALUES (900, '+966500000001')`);
  await q(`INSERT INTO scenarios (id, company_id, name, instruction_prompt) VALUES (900, 'co-live', 'S', 'p')`);
  await q(`INSERT INTO scenario_versions (scenario_id, instruction_prompt) VALUES (900, 'v1')`);

  // Now run the migrations under test.
  const { runPgMigrations } = require('../lib/migrations-pg');
  await runPgMigrations(q);
});

after(async () => { await close().catch(() => {}); });

test('every SQLite foreign key now exists on Postgres', async () => {
  const rows = (await q(`SELECT conname FROM pg_constraint WHERE contype = 'f'`)).rows;
  const present = new Set(rows.map((r) => r.conname));
  const missing = FOREIGN_KEYS
    .map(([t, c]) => `fk_${t}_${c}`)
    .filter((n) => !present.has(n));
  assert.deepEqual(missing, [], `missing FKs: ${missing.join(', ')}`);
  assert.ok(present.size >= 20, `expected >=20 FKs, got ${present.size}`);
});

test('orphan rows were cleaned, valid rows survived', async () => {
  const orphanChats = (await q(`SELECT count(*)::int n FROM chats WHERE company_id = 'co-GONE'`)).rows[0].n;
  assert.equal(orphanChats, 0, 'CASCADE-side orphan chats deleted');
  const liveChats = (await q(`SELECT count(*)::int n FROM chats WHERE company_id = 'co-live'`)).rows[0].n;
  assert.equal(liveChats, 1, 'legitimate row untouched');
});

test('SET NULL orphans keep the row but drop the dangling reference', async () => {
  // calls.company_id is ON DELETE SET NULL — a call with no company is still
  // a real call and must not be deleted.
  const r = (await q(`SELECT company_id FROM calls WHERE id = 'call-orphan'`)).rows;
  assert.equal(r.length, 1, 'call row preserved');
  assert.equal(r[0].company_id, null, 'dangling company reference nulled');
});

test('THE BUG: deleting a company now cascades instead of orphaning', async () => {
  await q(`INSERT INTO companies (id, name, language, system_prompt) VALUES ('co-doomed', 'Doomed', 'ar-SA', '')`);
  await q(`INSERT INTO chats (company_id, session_id, user_message) VALUES ('co-doomed', 's9', 'x')`);
  await q(`INSERT INTO kb_documents (id, company_id, filename) VALUES (9001, 'co-doomed', 'f.pdf')`);
  await q(`INSERT INTO scenarios (id, company_id, name, instruction_prompt) VALUES (901, 'co-doomed', 'S', 'p')`);

  await q(`DELETE FROM companies WHERE id = 'co-doomed'`);

  for (const t of ['chats', 'kb_documents', 'scenarios']) {
    const n = (await q(`SELECT count(*)::int n FROM ${t} WHERE company_id = 'co-doomed'`)).rows[0].n;
    assert.equal(n, 0, `${t} rows cascaded away`);
  }
});

test('nested cascade: company → document → chunks', async () => {
  await q(`INSERT INTO companies (id, name, language, system_prompt) VALUES ('co-nest', 'Nest', 'ar-SA', '')`);
  await q(`INSERT INTO kb_documents (id, company_id, filename) VALUES (9100, 'co-nest', 'd.pdf')`);
  await q(`INSERT INTO kb_chunks (company_id, document_id, chunk_index, text, embedding)
           VALUES ('co-nest', 9100, 0, 'chunk', $1::vector)`, ['[' + Array(1536).fill('0.001').join(',') + ']']);
  assert.equal((await q(`SELECT count(*)::int n FROM kb_chunks WHERE company_id='co-nest'`)).rows[0].n, 1);

  await q(`DELETE FROM companies WHERE id = 'co-nest'`);
  assert.equal((await q(`SELECT count(*)::int n FROM kb_chunks WHERE company_id='co-nest'`)).rows[0].n, 0,
    'chunks removed via document cascade');
});

test('denormalized company_id added AND backfilled from the parent', async () => {
  const cc = (await q(`SELECT company_id FROM campaign_contacts WHERE phone = '+966500000001'`)).rows[0];
  assert.equal(cc.company_id, 'co-live', 'campaign_contacts backfilled from campaigns');
  const sv = (await q(`SELECT company_id FROM scenario_versions WHERE instruction_prompt = 'v1'`)).rows[0];
  assert.equal(sv.company_id, 'co-live', 'scenario_versions backfilled from scenarios');
});

test('every RLS tenant table has the company_id column RLS requires', async () => {
  const { TENANT_TABLES } = require('../lib/rls');
  for (const t of TENANT_TABLES) {
    const n = (await q(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name='company_id'`, [t])).rows[0].n;
    assert.equal(n, 1, `${t} must have company_id for its RLS policy to work`);
  }
});

test('migrations are idempotent — a second run changes nothing', async () => {
  const before = (await q(`SELECT count(*)::int n FROM pg_constraint WHERE contype='f'`)).rows[0].n;
  const { runPgMigrations } = require('../lib/migrations-pg');
  const r = await runPgMigrations(q);
  const after = (await q(`SELECT count(*)::int n FROM pg_constraint WHERE contype='f'`)).rows[0].n;
  assert.equal(after, before, 'no duplicate constraints');
  assert.deepEqual(r.columns, [], 'no columns re-added');
  assert.deepEqual(r.foreignKeys, [], 'no FKs re-added');
});

test('RLS can be applied to all tenant tables after migration', async () => {
  const { applyRls, TENANT_TABLES } = require('../lib/rls');
  const applied = await applyRls(pool);
  assert.equal(applied.length, TENANT_TABLES.length,
    `RLS applied to ${applied.length}/${TENANT_TABLES.length} tables`);
  const n = (await q(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND rowsecurity = true`)).rows[0].n;
  assert.equal(n, TENANT_TABLES.length);
});
