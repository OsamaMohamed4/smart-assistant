// Idempotent PostgreSQL migrations, run at boot from db-postgres.initDb().
//
// Why this file exists: the Postgres schema (db-pg-schema.js) was written as
// pure `CREATE TABLE IF NOT EXISTS`, which cannot add anything to a table that
// already exists. It also shipped with ZERO foreign keys while the SQLite
// schema has 20 — so `DELETE FROM companies` orphaned every chat, call,
// document and chunk on production while behaving correctly in dev. Audit F-03.
//
// Design constraints:
//   - Every step is guarded by a catalog lookup, so re-running is a no-op and
//     a partially-applied state self-heals on the next boot.
//   - Orphan rows are cleaned BEFORE each constraint is added, otherwise
//     ADD CONSTRAINT fails and the whole boot fails.
//   - Each step is its own transaction: one failing constraint must not
//     prevent the others from applying.
//   - NOT VALID is deliberately NOT used — these tables are small and we want
//     existing rows verified now, not silently exempted.
const { logger } = require('./logger');

// [child table, column, parent table, parent column, ON DELETE action]
// Mirrors db-sqlite.js exactly. `users.company_id` intentionally CASCADEs:
// deleting a company removes its workspace logins, matching SQLite.
const FOREIGN_KEYS = [
  ['companies',        'user_id',     'users',         'id', 'SET NULL'],
  ['sessions',         'user_id',     'users',         'id', 'CASCADE'],
  ['auth_events',      'user_id',     'users',         'id', 'SET NULL'],
  ['users',            'company_id',  'companies',     'id', 'CASCADE'],
  ['chats',            'company_id',  'companies',     'id', 'CASCADE'],
  ['chats',            'user_id',     'users',         'id', 'SET NULL'],
  ['calls',            'company_id',  'companies',     'id', 'SET NULL'],
  ['kb_documents',     'company_id',  'companies',     'id', 'CASCADE'],
  ['kb_chunks',        'company_id',  'companies',     'id', 'CASCADE'],
  ['kb_chunks',        'document_id', 'kb_documents',  'id', 'CASCADE'],
  ['audit_events',     'actor_id',    'users',         'id', 'SET NULL'],
  ['usage_counters',   'company_id',  'companies',     'id', 'CASCADE'],
  ['scenarios',        'company_id',  'companies',     'id', 'CASCADE'],
  ['scenario_versions','scenario_id', 'scenarios',     'id', 'CASCADE'],
  ['whatsapp_sessions','company_id',  'companies',     'id', 'CASCADE'],
  ['api_keys',         'company_id',  'companies',     'id', 'CASCADE'],
  ['campaigns',        'company_id',  'companies',     'id', 'CASCADE'],
  ['campaign_contacts','campaign_id', 'campaigns',     'id', 'CASCADE'],
  ['eval_questions',   'company_id',  'companies',     'id', 'CASCADE'],
  ['eval_runs',        'company_id',  'companies',     'id', 'CASCADE'],
];

// Tables that need a denormalized company_id so Row-Level Security can police
// them directly. Both hold data reachable only through a parent today, which
// means a query that forgets to join is unprotected. campaign_contacts is the
// urgent one — it stores customer phone numbers. Audit F-05.
const DENORM_COMPANY_ID = [
  { table: 'campaign_contacts', parent: 'campaigns', parentKey: 'campaign_id' },
  { table: 'scenario_versions', parent: 'scenarios', parentKey: 'scenario_id' },
];

// Plain column additions: [table, column, type]. Nullable by design so
// existing rows stay valid and the change is backward compatible.
//   campaigns.created_by — the campaign report shows an owner, and this was
//     the only report field with no existing source.
const ADD_COLUMNS = [
  ['campaigns', 'created_by', 'TEXT'],
  // Minute-precision call window (was whole hours only). DEFAULT 0 backfills
  // existing rows to "on the hour", preserving their behaviour exactly.
  ['campaigns', 'start_minute', 'BIGINT NOT NULL DEFAULT 0'],
  ['campaigns', 'end_minute',   'BIGINT NOT NULL DEFAULT 0'],
];

const tableExists = async (q, t) =>
  !!(await q('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r;

const columnExists = async (q, t, c) =>
  (await q(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, c])).rowCount > 0;

const constraintExists = async (q, name) =>
  (await q(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name])).rowCount > 0;

// ─── Step 1: denormalized company_id columns ──────────────────────
async function addCompanyIdColumns(q) {
  const done = [];
  for (const { table, parent, parentKey } of DENORM_COMPANY_ID) {
    if (!(await tableExists(q, table)) || !(await tableExists(q, parent))) continue;
    if (await columnExists(q, table, 'company_id')) continue;

    await q('BEGIN');
    try {
      await q(`ALTER TABLE ${table} ADD COLUMN company_id TEXT`);
      // Backfill from the parent before anything reads the column.
      await q(`
        UPDATE ${table} c
           SET company_id = p.company_id
          FROM ${parent} p
         WHERE p.id = c.${parentKey} AND c.company_id IS NULL`);
      await q(`CREATE INDEX IF NOT EXISTS idx_${table}_company ON ${table}(company_id)`);
      await q('COMMIT');
      done.push(table);
    } catch (e) {
      await q('ROLLBACK').catch(() => {});
      logger.error('migration: add company_id failed', { table, err: e.message });
    }
  }
  return done;
}

// ─── Step 1b: plain nullable column additions ─────────────────────
async function addPlainColumns(q) {
  const done = [];
  for (const [table, col, type] of ADD_COLUMNS) {
    if (!(await tableExists(q, table))) continue;
    if (await columnExists(q, table, col)) continue;
    try {
      await q(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      done.push(`${table}.${col}`);
    } catch (e) {
      logger.error('migration: add column failed', { table, col, err: e.message });
    }
  }
  return done;
}

// ─── Step 2: foreign keys (+ orphan cleanup) ──────────────────────
// Orphans MUST go first or ADD CONSTRAINT rejects the table. For CASCADE
// columns an orphan is unreachable data, so it is deleted. For SET NULL
// columns the row itself is still meaningful (a call with no company is
// still a call), so we only null the dangling reference.
async function addForeignKeys(q) {
  const added = [];
  const cleaned = [];
  for (const [table, col, parent, parentCol, onDelete] of FOREIGN_KEYS) {
    const name = `fk_${table}_${col}`;
    if (!(await tableExists(q, table)) || !(await tableExists(q, parent))) continue;
    if (!(await columnExists(q, table, col))) continue;
    if (await constraintExists(q, name)) continue;

    await q('BEGIN');
    try {
      const orphanWhere = `${col} IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ${parent} p WHERE p.${parentCol} = ${table}.${col})`;
      const r = onDelete === 'CASCADE'
        ? await q(`DELETE FROM ${table} WHERE ${orphanWhere}`)
        : await q(`UPDATE ${table} SET ${col} = NULL WHERE ${orphanWhere}`);
      if (r.rowCount) {
        cleaned.push(`${table}.${col}:${r.rowCount}`);
        logger.warn('migration: cleaned orphan rows before FK', {
          table, col, action: onDelete === 'CASCADE' ? 'deleted' : 'nulled', rows: r.rowCount,
        });
      }
      await q(`ALTER TABLE ${table}
                 ADD CONSTRAINT ${name} FOREIGN KEY (${col})
                 REFERENCES ${parent}(${parentCol}) ON DELETE ${onDelete}`);
      await q('COMMIT');
      added.push(name);
    } catch (e) {
      await q('ROLLBACK').catch(() => {});
      logger.error('migration: add FK failed', { constraint: name, err: e.message });
    }
  }
  return { added, cleaned };
}

// Entry point. Never throws: a migration problem is logged and surfaced via
// the return value, but must not stop the server from booting and answering
// live calls.
async function runPgMigrations(q) {
  const columns = await addCompanyIdColumns(q);
  const plain = await addPlainColumns(q);
  const { added, cleaned } = await addForeignKeys(q);
  if (columns.length) logger.info('migration: company_id added', { tables: columns });
  if (plain.length)   logger.info('migration: columns added', { columns: plain });
  if (added.length)   logger.info('migration: foreign keys added', { count: added.length });
  if (!columns.length && !plain.length && !added.length) logger.info('migration: schema already current');
  return { columns, plainColumns: plain, foreignKeys: added, cleaned };
}

module.exports = { runPgMigrations, FOREIGN_KEYS, DENORM_COMPANY_ID, ADD_COLUMNS };
