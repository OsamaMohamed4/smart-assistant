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
const { runWithContext } = require('./tenant-context');

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
  ['user_companies',   'user_id',     'users',         'id', 'CASCADE'],
  ['user_companies',   'company_id',  'companies',     'id', 'CASCADE'],
  ['password_resets',  'user_id',     'users',         'id', 'CASCADE'],
  ['whatsapp_messages','company_id',  'companies',     'id', 'CASCADE'],
  ['whatsapp_threads', 'company_id',  'companies',     'id', 'CASCADE'],
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
//   companies.elevenlabs_* — the per-tenant ElevenLabs Agents binding. The
//     legacy assistant_id / assistant_id_inbound columns are deliberately NOT
//     dropped: historical calls reference them and dropping a column is the one
//     migration you cannot undo without a restore.
//   calls.provider / provider_call_ref — which provider produced the row, and
//     the provider's secondary id (ElevenLabs sip_call_id) for 3CX correlation.
const ADD_COLUMNS = [
  ['campaigns', 'created_by', 'TEXT'],
  // Minute-precision call window (was whole hours only). DEFAULT 0 backfills
  // existing rows to "on the hour", preserving their behaviour exactly.
  ['campaigns', 'start_minute', 'BIGINT NOT NULL DEFAULT 0'],
  ['campaigns', 'end_minute',   'BIGINT NOT NULL DEFAULT 0'],
  ['companies', 'voice_provider',              'TEXT'],
  ['companies', 'elevenlabs_agent_id',         'TEXT'],
  ['companies', 'elevenlabs_agent_id_inbound', 'TEXT'],
  ['companies', 'elevenlabs_phone_number_id',  'TEXT'],
  ['companies', 'elevenlabs_kb_tool_id',       'TEXT'],
  ['companies', 'elevenlabs_synced_at',        'TEXT'],
  ['calls',     'provider',                    'TEXT'],
  ['calls',     'provider_call_ref',           'TEXT'],
  // Whether audio exists, kept separate from recording_url — see db-pg-schema.
  ['calls',     'has_recording',               'BIGINT NOT NULL DEFAULT 0'],
  // Credits, not currency — the provider reports no fiat amount at all. No
  // backfill: historical rows have no credit figure and 0 would be a lie.
  ['calls',     'cost_credits',                'DOUBLE PRECISION'],
  // Explicit publish state. last_synced_at only ever recorded that a sync was
  // ATTEMPTED, so a company whose publish died halfway still looked synced.
  ['companies', 'publish_status',              'TEXT'],
  ['companies', 'published_at',                'TEXT'],
  // Company FACTS as JSON (description, hours, services, rules). Separate from
  // `settings` because that column is the superadmin-gated voice/cost surface.
  ['companies', 'business_profile',            'TEXT'],
  // The company a session is working in, for an account granted more than
  // one (user_companies). NULL means the user's home company.
  ['sessions',  'active_company_id',           'TEXT'],
];

// Partial UNIQUE indexes that enforce "one company per number". Separate from
// ADD_INDEXES because they can FAIL on an existing database that already holds
// duplicates, and that must be reported rather than either crashing the boot or
// silently deleting a tenant's number. See addUniqueOwnershipIndexes.
const UNIQUE_OWNERSHIP = [
  ['uq_companies_phone_number', 'companies', 'phone_number'],
  ['uq_companies_el_phone_id',  'companies', 'elevenlabs_phone_number_id'],
];

// Indexes the new lookup paths need. CREATE INDEX IF NOT EXISTS is already
// idempotent, so these need no catalog guard of their own.
const ADD_INDEXES = [
  ['idx_companies_el_agent', 'companies(elevenlabs_agent_id)'],
  ['idx_companies_el_phone', 'companies(elevenlabs_phone_number_id)'],
  ['idx_companies_phone',    'companies(phone_number)'],
  ['idx_calls_provider',     'calls(provider)'],
];

// One-shot data backfills. `check` decides whether there is anything left to
// do, so re-running costs one cheap EXISTS probe rather than a table scan.
const BACKFILLS = [
  // Every call that exists when this first runs came from Vapi — labelling them
  // explicitly keeps the dashboard and campaign report interpreting historical
  // ended_reason / structured_data with the right provider vocabulary.
  {
    table : 'calls',
    column: 'provider',
    check : `SELECT 1 FROM calls WHERE provider IS NULL LIMIT 1`,
    apply : `UPDATE calls SET provider = 'vapi' WHERE provider IS NULL`,
  },
  // Historical rows hold a real recording URL; the flag must agree with them so
  // no existing call loses its player when the UI switches to reading the flag.
  {
    table : 'calls',
    column: 'has_recording',
    check : `SELECT 1 FROM calls WHERE has_recording = 0 AND recording_url IS NOT NULL AND recording_url <> '' LIMIT 1`,
    apply : `UPDATE calls SET has_recording = 1 WHERE has_recording = 0 AND recording_url IS NOT NULL AND recording_url <> ''`,
  },
  // Adopt the knowledge-base tool each company already has. Without this, the
  // first publish after the capability layer ships finds no row for
  // knowledge_base, creates a SECOND tool at the provider and orphans the one
  // the agent is already using.
  {
    table : 'company_tools',
    column: 'elevenlabs_tool_id',
    check : `SELECT 1 FROM companies c
              WHERE c.elevenlabs_kb_tool_id IS NOT NULL AND c.elevenlabs_kb_tool_id <> ''
                AND NOT EXISTS (SELECT 1 FROM company_tools t
                                 WHERE t.company_id = c.id AND t.feature_key = 'knowledge_base')
              LIMIT 1`,
    apply : `INSERT INTO company_tools (company_id, feature_key, elevenlabs_tool_id)
             SELECT c.id, 'knowledge_base', c.elevenlabs_kb_tool_id
               FROM companies c
              WHERE c.elevenlabs_kb_tool_id IS NOT NULL AND c.elevenlabs_kb_tool_id <> ''
             ON CONFLICT (company_id, feature_key) DO NOTHING`,
  },
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

// ─── Step 1c: indexes ─────────────────────────────────────────────
async function addIndexes(q) {
  const done = [];
  for (const [name, target] of ADD_INDEXES) {
    const [table] = target.split('(');
    if (!(await tableExists(q, table))) continue;
    try {
      await q(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
      done.push(name);
    } catch (e) {
      logger.error('migration: add index failed', { index: name, err: e.message });
    }
  }
  return done;
}

// ─── Step 1c2: tenant-safety unique indexes ───────────────────────
// A DID and an imported provider number each identify exactly ONE tenant, and
// inbound calls are attributed through them — so a duplicate sends one
// company's calls into another company's records.
//
// Runs on EVERY boot rather than once: if the table already holds duplicates
// the index cannot be created, and neither failing the boot nor deleting one
// tenant's number is acceptable. So report the exact conflict and try again
// next boot — an operator fixes the rows and the constraint appears by itself.
async function addUniqueOwnershipIndexes(q) {
  const done = [];
  for (const [name, table, column] of UNIQUE_OWNERSHIP) {
    if (!(await tableExists(q, table))) continue;
    if (!(await columnExists(q, table, column))) continue;
    try {
      const dupes = await q(
        `SELECT ${column} AS value, count(*) AS n, array_agg(id) AS ids
           FROM ${table}
          WHERE ${column} IS NOT NULL AND ${column} <> ''
          GROUP BY ${column} HAVING count(*) > 1`,
      );
      if (dupes.rowCount) {
        for (const d of dupes.rows) {
          logger.error('migration: DUPLICATE phone ownership blocks tenant isolation', {
            table, column, companies: d.ids,
            action: `calls on this number cannot be attributed — clear ${column} from the wrong company, then restart to install ${name}`,
          });
        }
        continue;
      }
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}
                 ON ${table}(${column}) WHERE ${column} IS NOT NULL`);
      done.push(name);
    } catch (e) {
      logger.error('migration: unique ownership index failed', { index: name, err: e.message });
    }
  }
  return done;
}

// ─── Step 1d: one-shot data backfills ─────────────────────────────
// Skipped entirely once `check` finds nothing left to do, so this costs one
// cheap EXISTS probe per boot rather than a table scan.
//
// RLS: migrations run at boot, outside any HTTP request, so there is no tenant
// context — and `calls` is FORCE ROW LEVEL SECURITY, which fails closed. Both
// the probe and the UPDATE would therefore see ZERO rows and the backfill would
// silently do nothing while reporting success. Running under the explicit
// system bypass is the same context the webhook drain and campaign worker use
// for their own cross-tenant work.
async function runBackfills(q) {
  const done = [];
  for (const { table, column, check, apply } of BACKFILLS) {
    if (!(await tableExists(q, table))) continue;
    if (!(await columnExists(q, table, column))) continue;
    try {
      const pending = await q(check);
      if (!pending.rowCount) continue;
      const r = await q(apply);
      if (r.rowCount) done.push(`${table}.${column}:${r.rowCount}`);
    } catch (e) {
      logger.error('migration: backfill failed', { table, column, err: e.message });
    }
  }
  return done;
}

// ─── Step 1e: one-time data migrations ────────────────────────────
// Unlike BACKFILLS, which re-run whenever their probe finds work, these must
// happen exactly ONCE: they rewrite values an operator may legitimately set
// again afterwards. Each records its name in schema_migrations -- the table
// db-sqlite.js keeps the same history in -- once it has finished.
//
// `q` takes a fresh pool connection per call, so a BEGIN/COMMIT spread over
// several calls would not be one transaction. Each step is therefore written
// to be safe to repeat: a crash before the marker is written re-runs it on the
// next boot, and re-running finds nothing left to change.
const ONE_TIME = [
  {
    // The reference agent became every company's default (2026-10-13). The
    // tuning stored before then is mostly the settings screen's pre-filled
    // values -- gpt-4.1, 0.3, 400 -- written into the company on every save,
    // and it would outrank the reference on every publish. Voice choice,
    // transfer number, webhook and caps are untouched; see TUNING_KEYS.
    name: 'reset_agent_tuning_to_reference',
    async apply(q) {
      const { stripTuning } = require('./agent-defaults');
      const rows = (await q('SELECT id, settings FROM companies')).rows;
      let changed = 0;
      for (const r of rows) {
        const { settings, removed } = stripTuning(r.settings);
        if (!removed) continue;
        await q('UPDATE companies SET settings = $1 WHERE id = $2', [settings, r.id]);
        logger.info('migration: agent tuning reset to the reference', { companyId: r.id, removed });
        changed++;
      }
      return changed;
    },
  },
  {
    // ناصر becomes {{agent_name}} in every scenario, at the operator's request
    // (templateAgentName, lib/voices.js), so the name follows the company's
    // voice. The text as it was goes into the scenario's history first, so
    // السجل can bring it back. Re-running after a crash finds no ناصر left in
    // a scenario it already changed, so nothing is changed twice.
    name: 'replace_nasser_with_agent_name',
    async apply(q) {
      const { templateAgentName } = require('./voices');
      const FIELDS = ['first_message', 'first_message_inbound', 'instruction_prompt', 'instruction_prompt_inbound'];
      const rows = (await q(`SELECT id, company_id, name, ${FIELDS.join(', ')} FROM scenarios`)).rows;
      let changed = 0;
      for (const s of rows) {
        const next = FIELDS.map((k) => templateAgentName(s[k]));
        const occurrences = next.reduce((n, f) => n + f.count, 0);
        if (!occurrences) continue;
        await q(`INSERT INTO scenario_versions
                   (scenario_id, company_id, name, first_message, first_message_inbound, instruction_prompt, edited_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [s.id, s.company_id, s.name, s.first_message, s.first_message_inbound || '',
            s.instruction_prompt, 'النظام: ناصر ← {{agent_name}}']);
        await q(`UPDATE scenarios
                    SET first_message = $1, first_message_inbound = $2, instruction_prompt = $3,
                        instruction_prompt_inbound = $4,
                        updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
                  WHERE id = $5`, [...next.map((f) => f.text), s.id]);
        logger.info('migration: ناصر replaced with {{agent_name}}', { scenarioId: s.id, companyId: s.company_id, occurrences });
        changed++;
      }
      return changed;
    },
  },
];

async function runOneTimeMigrations(q) {
  const done = [];
  if (!(await tableExists(q, 'schema_migrations')) || !(await tableExists(q, 'companies'))) return done;
  for (const m of ONE_TIME) {
    try {
      const seen = await q('SELECT 1 FROM schema_migrations WHERE name = $1', [m.name]);
      if (seen.rowCount) continue;
      const n = await m.apply(q);
      await q(`INSERT INTO schema_migrations (id, name)
               SELECT COALESCE(MAX(id), 0) + 1, $1 FROM schema_migrations
                WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)`, [m.name]);
      done.push(`${m.name}:${n}`);
    } catch (e) {
      logger.error('migration: one-time step failed', { name: m.name, err: e.message });
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
  // Indexes and backfills run AFTER addPlainColumns so the columns they
  // reference are guaranteed to exist on the first boot that introduces them.
  const indexes = await addIndexes(q);
  const unique = await addUniqueOwnershipIndexes(q);
  // See runBackfills: row rewrites need the system bypass or RLS hides every
  // row from them and the backfill silently no-ops.
  const backfilled = await runWithContext(
    { bypass: true, companyId: null }, () => runBackfills(q),
  );
  const oneTime = await runWithContext(
    { bypass: true, companyId: null }, () => runOneTimeMigrations(q),
  );
  const { added, cleaned } = await addForeignKeys(q);
  if (columns.length)    logger.info('migration: company_id added', { tables: columns });
  if (plain.length)      logger.info('migration: columns added', { columns: plain });
  if (unique.length)     logger.info('migration: tenant-safety unique indexes added', { indexes: unique });
  if (backfilled.length) logger.info('migration: rows backfilled', { rows: backfilled });
  if (oneTime.length)    logger.info('migration: one-time steps applied', { steps: oneTime });
  if (added.length)      logger.info('migration: foreign keys added', { count: added.length });
  if (!columns.length && !plain.length && !added.length && !backfilled.length && !unique.length && !oneTime.length) {
    logger.info('migration: schema already current');
  }
  return { columns, plainColumns: plain, indexes, unique, backfilled, oneTime, foreignKeys: added, cleaned };
}

module.exports = {
  runPgMigrations, FOREIGN_KEYS, DENORM_COMPANY_ID, ADD_COLUMNS, ADD_INDEXES,
  UNIQUE_OWNERSHIP, BACKFILLS, ONE_TIME, runOneTimeMigrations,
  // Exported so the regression suite can re-run it against a database that
  // already holds a duplicate — the branch that must report the conflict
  // instead of taking the process down.
  addUniqueOwnershipIndexes,
};
