// Prepares a Postgres instance to run the smoke suite UNDER RLS as a
// NON-SUPERUSER, mirroring the intended production setup:
//   1. admin creates a clean schema + the non-superuser app role
//   2. the APP role creates/owns the schema (so boot-time migrations work)
//   3. RLS policies are enabled WITH FORCE, so they bind the owner too
//
// Usage:
//   ADMIN_DATABASE_URL=postgres://postgres:test@localhost:5434/satest \
//   APP_DATABASE_URL=postgres://app_rls:apppw@localhost:5434/satest \
//   node scripts/rls-verify-setup.js
require('dotenv').config();
const dbpg = require('../lib/db-pg');
const { applyRls } = require('../lib/rls');

const ADMIN = process.env.ADMIN_DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
process.env.DB_DRIVER = 'postgres'; // MUST be set before ../db is required

(async () => {
  if (!ADMIN || !APP) {
    console.error('ADMIN_DATABASE_URL and APP_DATABASE_URL are required');
    process.exit(1);
  }

  // ── Phase 1 — admin: clean schema + app role ──────────────────
  process.env.DATABASE_URL = ADMIN;
  let pool = dbpg.getPool();
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_rls') THEN CREATE ROLE app_rls LOGIN PASSWORD 'apppw' NOSUPERUSER; END IF; END $$;");
  await pool.query('GRANT ALL ON SCHEMA public TO app_rls');
  await dbpg.close();

  // ── Phase 2 — as the APP role: own the schema, then enable RLS ─
  process.env.DATABASE_URL = APP;
  const { initDb } = require('../db');
  await initDb();
  pool = dbpg.getPool();
  const who = await pool.query(
    'SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super');
  if (who.rows[0].is_super) {
    console.error('REFUSING: the app role is a SUPERUSER — RLS would be silently bypassed.');
    process.exit(1);
  }
  const applied = await applyRls(pool);
  console.log(`app role = ${who.rows[0].u} | superuser = ${who.rows[0].is_super}`);
  console.log(`RLS enabled+forced on ${applied.length} tables: ${applied.join(', ')}`);
  // Guard: applying to zero tables means the schema wasn't there — never let a
  // downstream "green" run be mistaken for proof that RLS was enforced.
  if (applied.length === 0) {
    console.error('REFUSING: RLS applied to 0 tables — schema missing, nothing would be enforced.');
    process.exit(1);
  }
  const on = await pool.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND rowsecurity = true");
  console.log(`verified: rowsecurity=true on ${on.rows[0].n} tables`);
  await dbpg.close();
})().catch((e) => { console.error('setup error:', e.message); process.exit(1); });
