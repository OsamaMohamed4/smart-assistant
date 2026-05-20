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
  getSession         : db.prepare('SELECT * FROM chats WHERE session_id = ? ORDER BY created_at ASC'),
  setSessionSummary  : db.prepare('UPDATE chats SET summary = ? WHERE session_id = ?'),

  // calls
  upsertCall         : db.prepare(`
    INSERT INTO calls (id, company_id, assistant_id, caller_number, duration_sec, started_at, ended_at, ended_reason, transcript, summary, cost_usd)
    VALUES (@id, @company_id, @assistant_id, @caller_number, @duration_sec, @started_at, @ended_at, @ended_reason, @transcript, @summary, @cost_usd)
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
      cost_usd      = excluded.cost_usd
  `),
  setCallSummary     : db.prepare('UPDATE calls SET summary = ? WHERE id = ?'),
  listCallsForCompany: db.prepare('SELECT * FROM calls WHERE company_id = ? ORDER BY created_at DESC LIMIT ?'),
  listAllCalls       : db.prepare('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?'),
  getCall            : db.prepare('SELECT * FROM calls WHERE id = ?'),

  // ─── RAG: KB documents + chunks ──────────────────────────
  insertDocument     : db.prepare(`
    INSERT INTO kb_documents (company_id, filename, mime_type, size_bytes, raw_text)
    VALUES (@company_id, @filename, @mime_type, @size_bytes, @raw_text)
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

module.exports = { db, sql };
