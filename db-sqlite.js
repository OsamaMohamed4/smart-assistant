const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// In production we mount the file from a persistent volume (Railway etc.) at a
// path like /data/data.db. Create the parent dir on boot so first-deploy on an
// empty volume doesn't crash with ENOENT.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema version tracking: every irreversible structural change registers a row
// in `schema_migrations`. Skip if already applied. Lets us evolve safely
// without sprinkling more PRAGMA introspection calls across the file.
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function runMigration(id, name, sqlText) {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id);
  if (applied) return;
  db.transaction(() => {
    db.exec(sqlText);
    db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(id, name);
  })();
}

// ─── Schema ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    name            TEXT,
    role            TEXT NOT NULL DEFAULT 'owner',
    failed_logins   INTEGER DEFAULT 0,
    locked_until    TEXT,
    last_login_at   TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT,
    user_agent   TEXT,
    ip           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS auth_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email      TEXT,
    event_type TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id);

  CREATE TABLE IF NOT EXISTS companies (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    language        TEXT DEFAULT 'ar-SA',
    voice_id        TEXT,
    phone_number    TEXT,
    assistant_id    TEXT,
    system_prompt   TEXT NOT NULL,
    kb_text         TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL,
    user_message  TEXT NOT NULL,
    assistant_reply TEXT,
    channel       TEXT DEFAULT 'text',        -- text | voice
    latency_ms    INTEGER,
    summary       TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chats_company  ON chats(company_id);
  CREATE INDEX IF NOT EXISTS idx_chats_session  ON chats(session_id);

  CREATE TABLE IF NOT EXISTS calls (
    id              TEXT PRIMARY KEY,           -- vapi call id
    company_id      TEXT REFERENCES companies(id) ON DELETE SET NULL,
    assistant_id    TEXT,
    caller_number   TEXT,
    duration_sec    INTEGER,
    started_at      TEXT,
    ended_at        TEXT,
    ended_reason    TEXT,
    transcript      TEXT,
    summary         TEXT,
    cost_usd        REAL,
    created_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_calls_company ON calls(company_id);

  CREATE TABLE IF NOT EXISTS kb_documents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    mime_type    TEXT,
    size_bytes   INTEGER,
    raw_text     TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_kbdocs_company ON kb_documents(company_id);

  CREATE TABLE IF NOT EXISTS kb_chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    TEXT NOT NULL,
    document_id   INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,
    text          TEXT NOT NULL,
    embedding     BLOB NOT NULL,
    token_count   INTEGER,
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_kbchunks_company ON kb_chunks(company_id);
  CREATE INDEX IF NOT EXISTS idx_kbchunks_doc     ON kb_chunks(document_id);

  -- Audit log for security/compliance-relevant actions beyond auth.
  CREATE TABLE IF NOT EXISTS audit_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_email  TEXT,
    action       TEXT NOT NULL,           -- e.g. company.create, client.delete, vapi.bind
    resource     TEXT,                    -- e.g. companies/acme
    metadata     TEXT,                    -- JSON blob with before/after if applicable
    ip           TEXT,
    user_agent   TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_events(actor_id);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);

  -- Per-tenant per-day usage counters for cost control (TTS, embeddings).
  CREATE TABLE IF NOT EXISTS usage_counters (
    company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    day          TEXT NOT NULL,           -- YYYY-MM-DD
    kind         TEXT NOT NULL,           -- tts_chars | embed_tokens | chat_tokens
    amount       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (company_id, day, kind)
  );
`);

// ─── Migrations (idempotent, tracked in schema_migrations) ─────
// Older databases may have CREATE TABLE without these columns. CREATE TABLE
// IF NOT EXISTS above won't add them — these named migrations do.
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

if (!hasColumn('companies', 'user_id')) {
  runMigration(1, 'companies_add_user_id',
    `ALTER TABLE companies ADD COLUMN user_id INTEGER REFERENCES users(id);
     CREATE INDEX IF NOT EXISTS idx_companies_user ON companies(user_id);`);
} else {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_companies_user ON companies(user_id)`);
}

if (!hasColumn('users', 'company_id')) {
  runMigration(2, 'users_add_company_id',
    `ALTER TABLE users ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
     CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);`);
} else {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)`);
}

if (!hasColumn('chats', 'user_id')) {
  runMigration(3, 'chats_add_user_id',
    `ALTER TABLE chats ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
}

// Migration 4: add soft-delete to kb_documents (added in security hardening).
if (!hasColumn('kb_documents', 'deleted_at')) {
  runMigration(4, 'kb_documents_add_deleted_at',
    `ALTER TABLE kb_documents ADD COLUMN deleted_at TEXT`);
}

// Migration 5: webhook inbox for idempotent processing + retry.
// Note: in SQLite, NULL values are considered distinct in a UNIQUE constraint,
// so events without a vendor id will coexist without artificial deduplication.
runMigration(5, 'create_webhook_events', `
  CREATE TABLE IF NOT EXISTS webhook_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT NOT NULL,
    event_id      TEXT,
    event_type    TEXT,
    raw_body      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    received_at   TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at  TEXT,
    UNIQUE (provider, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);
`);

// Migration 6: rebuild webhook_events with a full UNIQUE constraint instead
// of the partial index that earlier shipped (SQLite ON CONFLICT can't target
// partial indexes). Safe: any existing rows are an empty inbox in dev.
runMigration(6, 'webhook_events_full_unique', `
  DROP TABLE IF EXISTS webhook_events;
  CREATE TABLE webhook_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT NOT NULL,
    event_id      TEXT,
    event_type    TEXT,
    raw_body      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    received_at   TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at  TEXT,
    UNIQUE (provider, event_id)
  );
  CREATE INDEX idx_webhook_events_status ON webhook_events(status);
`);

// Migration 8: track the last successful Vapi sync so the UI can show an
// "unpublished changes" badge when the active scenario was edited after sync.
if (!hasColumn('companies', 'last_synced_at')) {
  runMigration(8, 'companies_add_last_synced_at',
    `ALTER TABLE companies ADD COLUMN last_synced_at TEXT`);
}

// Migration 7: scenarios — each company can author multiple AI agent scenarios
// (Customer Service / Booking / Sales / etc). At chat time the *active*
// scenario for the company replaces the legacy company.system_prompt.
runMigration(7, 'create_scenarios', `
  CREATE TABLE IF NOT EXISTS scenarios (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    description         TEXT,
    first_message       TEXT,
    instruction_prompt  TEXT NOT NULL,
    success_criteria    TEXT,
    variables           TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    language            TEXT DEFAULT 'ar',
    knowledge_base_ids  TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now')),
    deleted_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scenarios_company ON scenarios(company_id);
  CREATE INDEX IF NOT EXISTS idx_scenarios_active  ON scenarios(company_id, is_active, deleted_at);
`);

// Migration 9: a scenario now has two opening lines — one for inbound calls
// (no customer name available) and one for outbound (we know who we're
// calling). The Vapi assistant's default firstMessage is the inbound one;
// outbound calls override per-call with the personalized version.
// MUST run after migration 7 (which creates the scenarios table).
if (!hasColumn('scenarios', 'first_message_inbound')) {
  runMigration(9, 'scenarios_add_first_message_inbound',
    `ALTER TABLE scenarios ADD COLUMN first_message_inbound TEXT`);
}

// Migration 11: drop the qa_runs table. It was created by migration 10 for
// the (since-removed) Assistant Test page; the feature was rolled back, so
// the table is dead weight. IF EXISTS makes this safe on fresh databases
// where migration 10 never ran.
runMigration(11, 'drop_qa_runs', `
  DROP TABLE IF EXISTS qa_runs;
`);

// Migration 12: WhatsApp conversation continuity. Vapi assigns each text
// chat a chatId; passing it back as previousChatId keeps the conversation
// stateful. We store the (company, customer phone) → vapi_chat_id mapping
// so a customer messaging us over days resumes from where they left off.
runMigration(12, 'create_whatsapp_sessions', `
  CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_phone TEXT NOT NULL,
    vapi_chat_id   TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, customer_phone)
  );
`);

// Migration 13: track call direction (inbound vs outbound). Old rows default
// to 'inbound' since that was the only path supported when they were created.
// Outbound rows are inserted as stubs when the Playground initiates a call,
// then upserted with full data when the Vapi end-of-call-report arrives.
if (!hasColumn('calls', 'direction')) {
  runMigration(13, 'calls_add_direction',
    `ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_direction ON calls(direction);`);
}

if (!hasColumn('kb_documents', 'raw_data')) {
  runMigration(14, 'kb_documents_add_raw_data',
    `ALTER TABLE kb_documents ADD COLUMN raw_data BLOB`
  );
}

// Migration 15: scenario version history. Every edit snapshots the PREVIOUS
// state here first, so a company can roll back a bad edit — the safety net
// that lets non-technical users edit scenarios without fear.
runMigration(15, 'create_scenario_versions', `
  CREATE TABLE IF NOT EXISTS scenario_versions (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id            INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    name                   TEXT,
    first_message          TEXT,
    first_message_inbound  TEXT,
    instruction_prompt     TEXT,
    edited_by              TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scenario_versions_sc ON scenario_versions(scenario_id, created_at DESC);
`);

// Migration 16: per-company settings (voice + model overrides) as JSON, so a
// company can tune its agent without code/env changes. NULL = use defaults.
if (!hasColumn('companies', 'settings')) {
  runMigration(16, 'companies_add_settings',
    `ALTER TABLE companies ADD COLUMN settings TEXT`);
}

// Migration 17: optional per-direction inbound assistant. When a scenario has
// a non-empty instruction_prompt_inbound, syncVapi builds a SECOND assistant
// (companies.assistant_id_inbound) so inbound calls behave differently from
// outbound. Fully opt-in — empty means inbound uses the primary assistant, so
// existing companies are unchanged.
if (!hasColumn('companies', 'assistant_id_inbound')) {
  runMigration(17, 'companies_add_assistant_id_inbound',
    `ALTER TABLE companies ADD COLUMN assistant_id_inbound TEXT`);
}
if (!hasColumn('scenarios', 'instruction_prompt_inbound')) {
  runMigration(18, 'scenarios_add_instruction_prompt_inbound',
    `ALTER TABLE scenarios ADD COLUMN instruction_prompt_inbound TEXT`);
}

// Migration 19: time-range indexes. Every dashboard aggregation filters on
// created_at BETWEEN @from AND @to (optionally per company) — without these
// each dashboard load was a full table scan on calls + chats.
runMigration(19, 'add_created_at_indexes', `
  CREATE INDEX IF NOT EXISTS idx_calls_created          ON calls(created_at);
  CREATE INDEX IF NOT EXISTS idx_chats_created          ON chats(created_at);
  CREATE INDEX IF NOT EXISTS idx_calls_company_created  ON calls(company_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_chats_company_created  ON chats(company_id, created_at);
`);

// Migration 20: call recording URL. Vapi's end-of-call report has carried
// artifact.recordingUrl all along — we were discarding it.
if (!hasColumn('calls', 'recording_url')) {
  runMigration(20, 'calls_add_recording_url',
    `ALTER TABLE calls ADD COLUMN recording_url TEXT`);
}

// Migration 21: per-company API keys for the public Agent API. Replaces the
// single global AGENT_API_KEY (which let any holder talk to EVERY company's
// agent). Only the SHA-256 hash is stored; the plaintext is shown once at
// creation. Revocation is a soft flag so audit history survives.
runMigration(21, 'create_api_keys', `
  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         TEXT,
    key_hash     TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys(company_id);
`);

// Migration 22: structured lead-qualification data extracted by Vapi's
// post-call analysis (interest level, budget, area, callbacks...). JSON text.
if (!hasColumn('calls', 'structured_data')) {
  runMigration(22, 'calls_add_structured_data',
    `ALTER TABLE calls ADD COLUMN structured_data TEXT`);
}

// Migration 23: outbound campaigns. A campaign is a list of contacts the
// worker dials through the company's assistant inside a daily time window,
// with bounded concurrency and retries.
runMigration(23, 'create_campaigns', `
  CREATE TABLE IF NOT EXISTS campaigns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft',  -- draft|running|paused|completed|cancelled
    start_hour      INTEGER NOT NULL DEFAULT 10,    -- Saudi time (UTC+3)
    end_hour        INTEGER NOT NULL DEFAULT 21,
    max_concurrent  INTEGER NOT NULL DEFAULT 2,
    max_attempts    INTEGER NOT NULL DEFAULT 2,
    retry_delay_min INTEGER NOT NULL DEFAULT 60,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    started_at      TEXT,
    completed_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_company ON campaigns(company_id);
  CREATE INDEX IF NOT EXISTS idx_campaigns_status  ON campaigns(status);

  CREATE TABLE IF NOT EXISTS campaign_contacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    phone           TEXT NOT NULL,
    name            TEXT,
    variables       TEXT,                            -- JSON prompt vars
    status          TEXT NOT NULL DEFAULT 'pending', -- pending|calling|completed|no_answer|failed|cancelled
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    call_id         TEXT,
    last_error      TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cc_campaign_status ON campaign_contacts(campaign_id, status);
  CREATE INDEX IF NOT EXISTS idx_cc_call ON campaign_contacts(call_id);
`);

// Migration 24: eval harness. Golden questions per company + run history so
// prompt edits get a measurable score instead of vibes.
runMigration(24, 'create_evals', `
  CREATE TABLE IF NOT EXISTS eval_questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    question    TEXT NOT NULL,
    expected    TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_evalq_company ON eval_questions(company_id);

  CREATE TABLE IF NOT EXISTS eval_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    label         TEXT,                    -- 'active' or 'draft' or scenario name
    score         REAL,
    total         INTEGER,
    correct       INTEGER,
    partial       INTEGER,
    results       TEXT,                    -- JSON per-question verdicts
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_evalr_company ON eval_runs(company_id);
`);

// Migration 25: denormalized company_id on campaign_contacts and
// scenario_versions. Both were reachable only through their parent, so a query
// that forgot to join was unprotected — and campaign_contacts stores customer
// phone numbers. The column lets Postgres RLS police them directly (audit
// F-05); on SQLite it keeps the two drivers structurally identical.
// Backfilled from the parent so existing rows are covered too.
if (!hasColumn('campaign_contacts', 'company_id')) {
  runMigration(25, 'campaign_contacts_add_company_id', `
    ALTER TABLE campaign_contacts ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
    UPDATE campaign_contacts
       SET company_id = (SELECT c.company_id FROM campaigns c WHERE c.id = campaign_contacts.campaign_id)
     WHERE company_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cc_company ON campaign_contacts(company_id);
  `);
}

if (!hasColumn('scenario_versions', 'company_id')) {
  runMigration(26, 'scenario_versions_add_company_id', `
    ALTER TABLE scenario_versions ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
    UPDATE scenario_versions
       SET company_id = (SELECT s.company_id FROM scenarios s WHERE s.id = scenario_versions.scenario_id)
     WHERE company_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_scenario_versions_company ON scenario_versions(company_id);
  `);
}

// Migration 27: who created a campaign. The campaign report shows an owner
// ("Created by") and this was the ONLY report field with no existing source —
// everything else derives from campaigns / campaign_contacts / calls /
// structured_data. Nullable, so historical campaigns simply show "—".
if (!hasColumn('campaigns', 'created_by')) {
  runMigration(27, 'campaigns_add_created_by',
    `ALTER TABLE campaigns ADD COLUMN created_by TEXT`);
}

// ─── Prepared statements ──────────────────────────────────
const sql = {
  // users
  insertUser         : db.prepare(`
    INSERT INTO users (email, password_hash, name, role, company_id)
    VALUES (@email, @password_hash, @name, @role, @company_id)
  `),
  listClientsForCompany: db.prepare(`
    SELECT id, email, name, created_at, last_login_at
      FROM users
     WHERE role = 'client' AND company_id = ?
     ORDER BY created_at DESC
  `),
  deleteUser         : db.prepare('DELETE FROM users WHERE id = ?'),
  getUserByEmail     : db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById        : db.prepare('SELECT id, email, name, role, company_id, created_at, last_login_at FROM users WHERE id = ?'),
  countUsers         : db.prepare('SELECT COUNT(*) AS n FROM users'),
  bumpFailedLogin    : db.prepare(`
    UPDATE users
       SET failed_logins = failed_logins + 1,
           locked_until  = CASE
             WHEN failed_logins + 1 = 3 THEN datetime('now', '+30 seconds')
             WHEN failed_logins + 1 = 4 THEN datetime('now', '+2 minutes')
             WHEN failed_logins + 1 = 5 THEN datetime('now', '+15 minutes')
             WHEN failed_logins + 1 >= 6 THEN datetime('now', '+1 hour')
             ELSE locked_until
           END
     WHERE id = ?
  `),
  clearFailedLogins  : db.prepare(`
    UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?
  `),
  updatePassword     : db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),

  // sessions
  insertSession      : db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, user_agent, ip, last_seen_at)
    VALUES (@id, @user_id, @expires_at, @user_agent, @ip, datetime('now'))
  `),
  getSessionById     : db.prepare(`
    SELECT s.*, u.id AS uid, u.email, u.name AS user_name, u.role, u.company_id, u.locked_until
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND datetime(s.expires_at) > datetime('now')
  `),
  touchSession       : db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?"),
  touchAndExtendSession: db.prepare(
    "UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?"
  ),
  deleteSession      : db.prepare('DELETE FROM sessions WHERE id = ?'),
  deleteUserSessions : db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeExpired       : db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')"),

  // auth events
  logAuthEvent       : db.prepare(`
    INSERT INTO auth_events (user_id, email, event_type, ip, user_agent)
    VALUES (@user_id, @email, @event_type, @ip, @user_agent)
  `),

  // audit log (non-auth actions)
  logAuditEvent      : db.prepare(`
    INSERT INTO audit_events (actor_id, actor_email, action, resource, metadata, ip, user_agent)
    VALUES (@actor_id, @actor_email, @action, @resource, @metadata, @ip, @user_agent)
  `),

  // usage counters
  bumpUsage          : db.prepare(`
    INSERT INTO usage_counters (company_id, day, kind, amount) VALUES (@company_id, @day, @kind, @amount)
    ON CONFLICT(company_id, day, kind) DO UPDATE SET amount = amount + excluded.amount
  `),
  getUsage           : db.prepare(`
    SELECT amount FROM usage_counters WHERE company_id = ? AND day = ? AND kind = ?
  `),

  // superadmin headcount (to block deleting the last admin)
  countSuperadmins   : db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'"),

  // ─── Named statements that used to be inline db.prepare() calls ──
  // (centralized so the postgres driver can implement the same catalog)
  getUserPasswordHash: db.prepare('SELECT password_hash FROM users WHERE id = ?'),
  companyExists      : db.prepare('SELECT 1 AS one FROM companies WHERE id = ?'),
  // Single positional param matched against two columns (better-sqlite3's
  // numbered ?1 params need object binding, so use `? IN (...)` instead).
  companyByAssistantId: db.prepare(
    'SELECT id FROM companies WHERE ? IN (assistant_id, assistant_id_inbound)'
  ),
  companyByPhoneNumberId: db.prepare(`
    SELECT id FROM companies
     WHERE ? IN (json_extract(settings,'$.inboundPhoneNumberId'),
                 json_extract(settings,'$.outboundPhoneNumberId'))
  `),
  setCompanySynced   : db.prepare(`
    UPDATE companies
       SET assistant_id = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?
  `),
  countWebhooksByStatus: db.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE status = ?'),
  listCompanyIdNames : db.prepare('SELECT id, name FROM companies'),
  getCompanyIdName   : db.prepare('SELECT id, name FROM companies WHERE id = ?'),
  companiesStats     : db.prepare(`
    SELECT c.id AS company_id,
      (SELECT COUNT(DISTINCT session_id) FROM chats WHERE company_id = c.id) AS chats,
      (SELECT COUNT(*) FROM calls WHERE company_id = c.id) AS calls,
      (SELECT MAX(ts) FROM (
        SELECT MAX(created_at) AS ts FROM chats WHERE company_id = c.id
        UNION ALL
        SELECT MAX(created_at) AS ts FROM calls WHERE company_id = c.id
      )) AS last_activity
    FROM companies c
  `),

  // webhook inbox — store-first-then-process for at-least-once delivery
  insertWebhookEvent : db.prepare(`
    INSERT INTO webhook_events (provider, event_id, event_type, raw_body, status)
    VALUES (@provider, @event_id, @event_type, @raw_body, 'pending')
    ON CONFLICT(provider, event_id) DO NOTHING
  `),
  markWebhookProcessed: db.prepare(`
    UPDATE webhook_events SET status = 'processed', processed_at = datetime('now') WHERE id = ?
  `),
  markWebhookFailed  : db.prepare(`
    UPDATE webhook_events
       SET status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
           attempts = attempts + 1,
           last_error = ?
     WHERE id = ?
  `),
  listPendingWebhooks: db.prepare(`
    SELECT * FROM webhook_events
     WHERE status = 'pending' AND attempts < 5
     ORDER BY received_at ASC LIMIT ?
  `),


  // companies
  listCompanies      : db.prepare('SELECT * FROM companies ORDER BY created_at DESC'),
  getCompany         : db.prepare('SELECT * FROM companies WHERE id = ?'),
  claimOrphanCompanies: db.prepare('UPDATE companies SET user_id = ? WHERE user_id IS NULL'),
  insertCompany      : db.prepare(`
    INSERT INTO companies (id, user_id, name, language, voice_id, phone_number, assistant_id, system_prompt, kb_text)
    VALUES (@id, @user_id, @name, @language, @voice_id, @phone_number, @assistant_id, @system_prompt, @kb_text)
  `),
  updateCompanySettings: db.prepare(
    `UPDATE companies SET settings = @settings, updated_at = datetime('now') WHERE id = @id`
  ),
  updateCompany      : db.prepare(`
    UPDATE companies SET
      name           = @name,
      language       = @language,
      voice_id       = @voice_id,
      phone_number   = @phone_number,
      assistant_id   = @assistant_id,
      system_prompt  = @system_prompt,
      kb_text        = @kb_text,
      updated_at     = datetime('now')
    WHERE id = @id
  `),
  deleteCompany      : db.prepare('DELETE FROM companies WHERE id = ?'),

  // chats
  insertChat         : db.prepare(`
    INSERT INTO chats (company_id, session_id, user_message, assistant_reply, channel, latency_ms, user_id)
    VALUES (@company_id, @session_id, @user_message, @assistant_reply, @channel, @latency_ms, @user_id)
  `),
  listChatsForCompany: db.prepare(`
    SELECT * FROM chats WHERE company_id = ? ORDER BY created_at DESC LIMIT ?
  `),
  listSessionsForCompany: db.prepare(`
    SELECT session_id,
           COUNT(*)               AS messages,
           MAX(created_at)        AS last_at,
           MAX(summary)           AS summary
    FROM chats
    WHERE company_id = ?
    GROUP BY session_id
    ORDER BY last_at DESC
    LIMIT ?
  `),
  // Company-scoped: session_id alone is guessable, so the tenant is always
  // part of the predicate (belt to the route guard's braces).
  getSession         : db.prepare('SELECT * FROM chats WHERE session_id = ? AND company_id = ? ORDER BY created_at ASC'),
  setSessionSummary  : db.prepare('UPDATE chats SET summary = ? WHERE session_id = ? AND company_id = ?'),

  // calls
  upsertCall         : db.prepare(`
    INSERT INTO calls (id, company_id, assistant_id, caller_number, duration_sec, started_at, ended_at, ended_reason, transcript, summary, cost_usd, direction, recording_url, structured_data)
    VALUES (@id, @company_id, @assistant_id, @caller_number, @duration_sec, @started_at, @ended_at, @ended_reason, @transcript, @summary, @cost_usd, @direction, @recording_url, @structured_data)
    ON CONFLICT(id) DO UPDATE SET
      company_id    = excluded.company_id,
      assistant_id  = excluded.assistant_id,
      caller_number = excluded.caller_number,
      duration_sec  = excluded.duration_sec,
      started_at    = excluded.started_at,
      ended_at      = excluded.ended_at,
      ended_reason  = excluded.ended_reason,
      transcript    = COALESCE(excluded.transcript, calls.transcript),
      summary       = COALESCE(excluded.summary, calls.summary),
      cost_usd      = excluded.cost_usd,
      direction     = COALESCE(excluded.direction, calls.direction),
      recording_url = COALESCE(excluded.recording_url, calls.recording_url),
      structured_data = COALESCE(excluded.structured_data, calls.structured_data)
  `),
  // Stub row written when we initiate an outbound call so the attempt is
  // visible in the Conversations table even before Vapi's end-of-call webhook
  // arrives (or if it never does). Idempotent on call id — the later upsert
  // from the webhook fills in transcript/duration/etc.
  insertOutboundCallStub: db.prepare(`
    INSERT INTO calls (id, company_id, assistant_id, caller_number, started_at, direction)
    VALUES (@id, @company_id, @assistant_id, @caller_number, datetime('now'), 'outbound')
    ON CONFLICT(id) DO NOTHING
  `),
  setCallSummary     : db.prepare('UPDATE calls SET summary = ? WHERE id = ?'),
  listCallsForCompany: db.prepare('SELECT * FROM calls WHERE company_id = ? ORDER BY created_at DESC LIMIT ?'),
  listAllCalls       : db.prepare('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?'),
  getCall            : db.prepare('SELECT * FROM calls WHERE id = ?'),

  // ─── RAG: KB documents + chunks ──────────────────────────
  insertDocument     : db.prepare(`
    INSERT INTO kb_documents (company_id, filename, mime_type, size_bytes, raw_text, raw_data)
    VALUES (@company_id, @filename, @mime_type, @size_bytes, @raw_text, @raw_data)
  `),
  insertChunk        : db.prepare(`
    INSERT INTO kb_chunks (company_id, document_id, chunk_index, text, embedding, token_count)
    VALUES (@company_id, @document_id, @chunk_index, @text, @embedding, @token_count)
  `),
  listDocuments      : db.prepare(`
    SELECT d.id, d.filename, d.mime_type, d.size_bytes, d.created_at,
           (SELECT COUNT(*) FROM kb_chunks WHERE document_id = d.id) AS chunk_count
    FROM kb_documents d
    WHERE d.company_id = ? AND d.deleted_at IS NULL
    ORDER BY d.created_at DESC
  `),
  getDocument        : db.prepare('SELECT * FROM kb_documents WHERE id = ? AND deleted_at IS NULL'),
  // Soft-delete: mark + drop the searchable chunks so it won't be retrieved.
  // Audit log captures the operation; restoration is a manual SQL update.
  deleteDocument     : db.prepare("UPDATE kb_documents SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"),
  purgeDocumentChunks: db.prepare('DELETE FROM kb_chunks WHERE document_id = ?'),
  countCompanyChunks : db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE company_id = ?'),
  listCompanyChunks  : db.prepare(`
    SELECT id, document_id, chunk_index, text, embedding
    FROM kb_chunks WHERE company_id = ?
  `),
  listChunksForDoc   : db.prepare(`
    SELECT id, chunk_index, text, token_count
    FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index ASC
  `),
  // Texts only (no embedding blobs) — keyword leg of the hybrid search.
  listCompanyChunkTexts: db.prepare(`
    SELECT id, document_id, text FROM kb_chunks WHERE company_id = ?
  `),
  updateChunkEmbedding: db.prepare(`
    UPDATE kb_chunks SET embedding = @embedding WHERE id = @id
  `),
  // All chunks for a company, ordered for stable concatenation. Used at
  // Vapi sync time to bake the KB into the assistant's system prompt
  // (Vapi can't reach our DB at call time, so we inline it once).
  listAllChunksForCompany: db.prepare(`
    SELECT c.id, c.document_id, c.chunk_index, c.text, d.filename
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
     WHERE c.company_id = ?
       AND d.deleted_at IS NULL
     ORDER BY d.id ASC, c.chunk_index ASC
  `),

  // ─── Scenarios (per-company AI agent configurations) ─────
  // Soft-deletes via deleted_at so we can show a "Recently Deleted" tab
  // without losing history. listScenarios excludes deleted rows by default.
  insertScenario     : db.prepare(`
    INSERT INTO scenarios (
      company_id, name, description, first_message, first_message_inbound,
      instruction_prompt, success_criteria, variables, is_active, language,
      knowledge_base_ids
    ) VALUES (
      @company_id, @name, @description, @first_message, @first_message_inbound,
      @instruction_prompt, @success_criteria, @variables, @is_active, @language,
      @knowledge_base_ids
    )
  `),
  updateScenario     : db.prepare(`
    UPDATE scenarios SET
      name                    = @name,
      description             = @description,
      first_message           = @first_message,
      first_message_inbound   = @first_message_inbound,
      instruction_prompt      = @instruction_prompt,
      success_criteria        = @success_criteria,
      variables               = @variables,
      is_active               = @is_active,
      language                = @language,
      knowledge_base_ids      = @knowledge_base_ids,
      updated_at              = datetime('now')
    WHERE id = @id AND deleted_at IS NULL
  `),
  // Set only the optional inbound prompt (additive — avoids touching the main
  // insert/update statements and their many call sites).
  setScenarioInboundPrompt: db.prepare(`
    UPDATE scenarios SET instruction_prompt_inbound = @v, updated_at = datetime('now')
     WHERE id = @id AND deleted_at IS NULL
  `),
  setCompanyInboundAssistant: db.prepare(
    `UPDATE companies SET assistant_id_inbound = @aid, updated_at = datetime('now') WHERE id = @id`
  ),
  listScenarios      : db.prepare(`
    SELECT id, company_id, name, description, language, is_active,
           created_at, updated_at,
           success_criteria
      FROM scenarios
     WHERE company_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC
  `),
  listDeletedScenarios: db.prepare(`
    SELECT id, name, language, deleted_at
      FROM scenarios
     WHERE company_id = ? AND deleted_at IS NOT NULL
     ORDER BY deleted_at DESC
  `),
  getScenario        : db.prepare(`
    SELECT * FROM scenarios WHERE id = ? AND deleted_at IS NULL
  `),
  // Pick the scenario the chat handler will use. Latest active wins; if none
  // is active the platform falls back to company.system_prompt.
  getActiveScenarioForCompany: db.prepare(`
    SELECT * FROM scenarios
     WHERE company_id = ? AND is_active = 1 AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 1
  `),
  setScenarioActive  : db.prepare(`
    UPDATE scenarios SET is_active = @is_active, updated_at = datetime('now')
     WHERE id = @id AND deleted_at IS NULL
  `),
  // Used by the "exclusive activate" transaction below — clears all active
  // flags inside a company before we set the new winner. Optionally excludes
  // a scenario id we're about to flip ON so we don't toggle it twice.
  deactivateAllScenariosForCompany: db.prepare(`
    UPDATE scenarios
       SET is_active = 0, updated_at = datetime('now')
     WHERE company_id = @company_id
       AND id != @except_id
       AND is_active = 1
       AND deleted_at IS NULL
  `),
  softDeleteScenario : db.prepare(`
    UPDATE scenarios SET deleted_at = datetime('now'), is_active = 0
     WHERE id = ? AND deleted_at IS NULL
  `),
  // Helper used by the post-migration backfill to find every company that
  // currently has more than one active scenario.
  listCompaniesWithMultipleActives: db.prepare(`
    SELECT company_id, COUNT(*) AS n
      FROM scenarios
     WHERE is_active = 1 AND deleted_at IS NULL
     GROUP BY company_id
     HAVING n > 1
  `),
  pickNewestActiveScenarioId: db.prepare(`
    SELECT id FROM scenarios
     WHERE company_id = ? AND is_active = 1 AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 1
  `),
  restoreScenario    : db.prepare(`
    UPDATE scenarios SET deleted_at = NULL WHERE id = ?
  `),

  // ─── Scenario version history (rollback) ────────────────────
  insertScenarioVersion: db.prepare(`
    INSERT INTO scenario_versions
      (scenario_id, company_id, name, first_message, first_message_inbound, instruction_prompt, edited_by)
    VALUES
      (@scenario_id, @company_id, @name, @first_message, @first_message_inbound, @instruction_prompt, @edited_by)
  `),
  listScenarioVersions : db.prepare(`
    SELECT id, name, edited_by, created_at,
           length(instruction_prompt) AS prompt_len
      FROM scenario_versions
     WHERE scenario_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 30
  `),
  getScenarioVersion   : db.prepare(`SELECT * FROM scenario_versions WHERE id = ?`),
  pruneScenarioVersions: db.prepare(`
    DELETE FROM scenario_versions
     WHERE scenario_id = ?
       AND id NOT IN (
         SELECT id FROM scenario_versions
          WHERE scenario_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 30
       )
  `),

  // ─── API keys (public Agent API, per company) ───────────────
  insertApiKey       : db.prepare(`
    INSERT INTO api_keys (company_id, name, key_hash, prefix)
    VALUES (@company_id, @name, @key_hash, @prefix)
  `),
  listApiKeysForCompany: db.prepare(`
    SELECT id, name, prefix, created_at, last_used_at, revoked_at
      FROM api_keys WHERE company_id = ? ORDER BY created_at DESC
  `),
  getApiKeyByHash    : db.prepare(`
    SELECT k.*, c.id AS company_exists
      FROM api_keys k JOIN companies c ON c.id = k.company_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL
  `),
  touchApiKey        : db.prepare(`
    UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?
  `),
  revokeApiKey       : db.prepare(`
    UPDATE api_keys SET revoked_at = datetime('now')
     WHERE id = ? AND company_id = ? AND revoked_at IS NULL
  `),

  // ─── Campaigns (outbound dialer) ─────────────────────────────
  insertCampaign     : db.prepare(`
    INSERT INTO campaigns (company_id, name, status, start_hour, end_hour, max_concurrent, max_attempts, retry_delay_min, created_by)
    VALUES (@company_id, @name, 'draft', @start_hour, @end_hour, @max_concurrent, @max_attempts, @retry_delay_min, @created_by)
  `),
  // Campaign report: one round trip joining every contact to its call row.
  // LEFT JOIN because a contact may not have been dialled yet, or the
  // end-of-call webhook may not have landed. All report fields come from
  // here — no second query, no AI pass.
  campaignReportRows : db.prepare(`
    SELECT cc.id, cc.phone, cc.name, cc.status, cc.attempts, cc.last_attempt_at,
           cc.call_id, cc.last_error, cc.created_at,
           c.duration_sec, c.started_at AS call_started_at, c.ended_at AS call_ended_at,
           c.ended_reason, c.summary, c.structured_data, c.recording_url
      FROM campaign_contacts cc
      LEFT JOIN calls c ON c.id = cc.call_id
     WHERE cc.campaign_id = ?
     ORDER BY cc.id ASC
  `),
  getCampaign        : db.prepare('SELECT * FROM campaigns WHERE id = ?'),
  listCampaignsForCompany: db.prepare('SELECT * FROM campaigns WHERE company_id = ? ORDER BY created_at DESC'),
  listRunningCampaigns: db.prepare("SELECT * FROM campaigns WHERE status = 'running'"),
  setCampaignStatus  : db.prepare(`
    UPDATE campaigns SET status = @status, updated_at = datetime('now') WHERE id = @id
  `),
  startCampaign      : db.prepare(`
    UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
     WHERE id = ? AND status IN ('draft','paused')
  `),
  completeCampaign   : db.prepare(`
    UPDATE campaigns SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `),
  insertCampaignContact: db.prepare(`
    INSERT INTO campaign_contacts (campaign_id, company_id, phone, name, variables)
    VALUES (@campaign_id, @company_id, @phone, @name, @variables)
  `),
  listCampaignContacts: db.prepare(`
    SELECT * FROM campaign_contacts WHERE campaign_id = ? ORDER BY id ASC LIMIT ?
  `),
  campaignContactStats: db.prepare(`
    SELECT status, COUNT(*) AS n FROM campaign_contacts WHERE campaign_id = ? GROUP BY status
  `),
  pickPendingContacts: db.prepare(`
    SELECT * FROM campaign_contacts WHERE campaign_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?
  `),
  countCallingContacts: db.prepare(`
    SELECT COUNT(*) AS n FROM campaign_contacts WHERE campaign_id = ? AND status = 'calling'
  `),
  countRemainingContacts: db.prepare(`
    SELECT COUNT(*) AS n FROM campaign_contacts
     WHERE campaign_id = ? AND (status IN ('pending','calling')
        OR (status IN ('failed','no_answer') AND attempts < ?))
  `),
  // Atomic claim: only flips a *pending* row, so an overlapping tick (or a
  // second instance) can never double-dial the same contact.
  claimContact       : db.prepare(`
    UPDATE campaign_contacts
       SET status = 'calling', attempts = attempts + 1,
           last_attempt_at = @at, last_error = NULL
     WHERE id = @id AND status = 'pending'
  `),
  setContactCallId   : db.prepare('UPDATE campaign_contacts SET call_id = @call_id WHERE id = @id'),
  markContactError   : db.prepare(`
    UPDATE campaign_contacts SET status = 'failed', last_error = @err WHERE id = @id
  `),
  updateContactByCallId: db.prepare(`
    UPDATE campaign_contacts SET status = @status, last_error = @err
     WHERE call_id = @call_id AND status = 'calling'
  `),
  requeueRetryContacts: db.prepare(`
    UPDATE campaign_contacts SET status = 'pending'
     WHERE campaign_id = ? AND status IN ('failed','no_answer')
       AND attempts < ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
  `),
  requeueStaleCalling: db.prepare(`
    UPDATE campaign_contacts SET status = 'failed', last_error = 'timeout: no end-of-call report'
     WHERE campaign_id = ? AND status = 'calling' AND last_attempt_at <= ?
  `),
  cancelCampaignContacts: db.prepare(`
    UPDATE campaign_contacts SET status = 'cancelled'
     WHERE campaign_id = ? AND status IN ('pending','calling')
  `),

  // ─── Evals (golden questions + runs) ─────────────────────────
  insertEvalQuestion : db.prepare(`
    INSERT INTO eval_questions (company_id, question, expected) VALUES (@company_id, @question, @expected)
  `),
  listEvalQuestions  : db.prepare('SELECT * FROM eval_questions WHERE company_id = ? ORDER BY id ASC'),
  deleteEvalQuestion : db.prepare('DELETE FROM eval_questions WHERE id = ? AND company_id = ?'),
  insertEvalRun      : db.prepare(`
    INSERT INTO eval_runs (company_id, label, score, total, correct, partial, results)
    VALUES (@company_id, @label, @score, @total, @correct, @partial, @results)
  `),
  listEvalRuns       : db.prepare('SELECT id, label, score, total, correct, partial, created_at FROM eval_runs WHERE company_id = ? ORDER BY id DESC LIMIT 20'),
  getEvalRun         : db.prepare('SELECT * FROM eval_runs WHERE id = ? AND company_id = ?'),

  // ─── Audit log (read side) ───────────────────────────────────
  listAuditEvents    : db.prepare(`
    SELECT id, actor_email, action, resource, metadata, ip, created_at
      FROM audit_events ORDER BY id DESC LIMIT ?
  `),

  // ─── WhatsApp sessions ──────────────────────────────────────
  getWhatsappSession   : db.prepare(`
    SELECT vapi_chat_id FROM whatsapp_sessions
     WHERE company_id = ? AND customer_phone = ?
  `),
  upsertWhatsappSession: db.prepare(`
    INSERT INTO whatsapp_sessions (company_id, customer_phone, vapi_chat_id, updated_at)
    VALUES (@company_id, @customer_phone, @vapi_chat_id, datetime('now'))
    ON CONFLICT(company_id, customer_phone) DO UPDATE
       SET vapi_chat_id = excluded.vapi_chat_id,
           updated_at   = datetime('now')
  `),

  // ─── Dashboard analytics ─────────────────────────────────
  // All aggregations accept @from/@to (ISO timestamps) and optional @company_id
  // (pass NULL for platform-wide stats). Keeping them as raw COUNT/AVG so the
  // dashboard doesn't have to scan whole tables in JS.
  countCallsInRange    : db.prepare(`
    SELECT COUNT(*) AS n FROM calls
     WHERE created_at BETWEEN @from AND @to
       AND (@company_id IS NULL OR company_id = @company_id)
  `),
  avgCallDurationInRange: db.prepare(`
    SELECT AVG(duration_sec) AS avg_dur FROM calls
     WHERE created_at BETWEEN @from AND @to
       AND duration_sec IS NOT NULL AND duration_sec > 0
       AND (@company_id IS NULL OR company_id = @company_id)
  `),
  // "Successful" call = lasted ≥10s and didn't end with an error reason.
  // Crude proxy until we add an explicit outcome column.
  callSuccessRateInRange: db.prepare(`
    SELECT
      SUM(CASE
            WHEN duration_sec >= 10
             AND COALESCE(ended_reason,'') NOT IN ('error','failed','no-answer','silence-timed-out','customer-did-not-give-microphone-permission')
          THEN 1 ELSE 0 END) AS ok,
      COUNT(*) AS total
    FROM calls
    WHERE created_at BETWEEN @from AND @to
      AND (@company_id IS NULL OR company_id = @company_id)
  `),
  countChatSessionsInRange: db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS n FROM chats
     WHERE created_at BETWEEN @from AND @to
       AND (@company_id IS NULL OR company_id = @company_id)
  `),
  countActiveCompanies: db.prepare(`
    SELECT COUNT(DISTINCT id) AS n FROM companies
     WHERE assistant_id IS NOT NULL
       AND (@company_id IS NULL OR id = @company_id)
  `),
  // Hourly bucket — used for the inbound/outbound chart. SQLite uses substr
  // because strftime against TEXT created_at with trailing fractional seconds
  // sometimes returns NULL on Windows builds.
  callsPerHourInRange : db.prepare(`
    SELECT substr(created_at, 12, 2) AS hour,
           COALESCE(direction, 'inbound') AS direction,
           COUNT(*) AS n
      FROM calls
     WHERE created_at BETWEEN @from AND @to
       AND (@company_id IS NULL OR company_id = @company_id)
     GROUP BY hour, COALESCE(direction, 'inbound')
  `),
  chatsPerHourInRange : db.prepare(`
    SELECT substr(created_at, 12, 2) AS hour, COUNT(*) AS n
      FROM chats
     WHERE created_at BETWEEN @from AND @to
       AND (@company_id IS NULL OR company_id = @company_id)
     GROUP BY hour
  `),
};

// Auto-seed companies from local JSON files if the database is completely empty.
// This is extremely helpful on a fresh Railway Persistent Volume deployment.
try {
  const count = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
  if (count === 0) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'companies');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      console.log(`[Auto-Seed] Empty database detected. Seeding from ${files.length} company files...`);
      for (const f of files) {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const kbPath = path.join(dir, `${cfg.id}.kb.md`);
        const kb = fs.existsSync(kbPath) ? fs.readFileSync(kbPath, 'utf8') : null;
        db.prepare(`
          INSERT INTO companies (id, name, language, voice_id, phone_number, assistant_id, system_prompt, kb_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cfg.id,
          cfg.name,
          cfg.language || 'ar-SA',
          cfg.voice_id || process.env.ELEVENLABS_VOICE_ID || null,
          cfg.phone_number || null,
          null,
          cfg.systemPrompt,
          kb
        );
        console.log(`[Auto-Seed] Created company: ${cfg.id} (${cfg.name})`);
      }
    }
  }
} catch (e) {
  console.error('[Auto-Seed] Failed to auto-seed database:', e.message);
}

// One-time cleanup: drop the legacy demo seed companies if they're still
// around. The seed JSON files have been deleted from disk, but volumes
// created when the files still existed will already have these rows.
// Idempotent — a no-op once the rows are gone.
try {
  const r = db.prepare("DELETE FROM companies WHERE id IN ('acme', 'techstore')").run();
  if (r.changes) console.log(`[Cleanup] Removed ${r.changes} demo seed companies`);
} catch (e) {
  console.error('[Cleanup] demo companies failed:', e.message);
}

// ─── Startup backfill: enforce one-active-scenario per company ─────
// Older databases let several scenarios stay flagged is_active=1 at once.
// The new policy is single-active per company; pick the most recently
// edited one as the winner and clear the rest.
try {
  const dupes = sql.listCompaniesWithMultipleActives.all();
  for (const { company_id } of dupes) {
    const winner = sql.pickNewestActiveScenarioId.get(company_id);
    if (!winner) continue;
    sql.deactivateAllScenariosForCompany.run({ company_id, except_id: winner.id });
    console.log(`[Backfill] company=${company_id} → kept scenario ${winner.id} active`);
  }
} catch (e) {
  console.error('[Backfill] one-active-scenario failed:', e.message);
}

// ─── Driver-agnostic helpers (same API shape as db-postgres.js) ────
// Dynamic SQL with ?-placeholders; named statements live in sql above.
const get = (text, params = []) => db.prepare(text).get(...params);
const all = (text, params = []) => db.prepare(text).all(...params);
const run = (text, params = []) => db.prepare(text).run(...params);

// Async-friendly transaction wrapper. better-sqlite3 db.transaction()
// requires a sync fn, but the pg driver is async — so both drivers expose
// withTransaction(asyncFn). Under sqlite the BEGIN/COMMIT pair is manual;
// Node is single-threaded and every statement inside is sync, so nothing
// interleaves as long as callers do not await external I/O mid-transaction
// (the existing call sites do not).
async function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = await fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

async function initDb() { /* schema applied synchronously at require */ }
async function healthCheck() { db.prepare('SELECT 1').get(); return true; }
async function close() { try { db.close(); } catch {} }

module.exports = { db, sql, get, all, run, withTransaction, initDb, healthCheck, close, isPg: false };
