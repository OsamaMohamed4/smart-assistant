// PostgreSQL driver: implements the SAME statement catalog as db-sqlite.js
// (same names, same call conventions) so the rest of the codebase is driver
// agnostic. Differences handled here, once:
//   - named @params → positional $n (each statement declares its param order)
//   - datetime('now') → TEXT now expression (string-comparison parity)
//   - .run() returns { changes, lastInsertRowid } (RETURNING id on inserts)
//   - embeddings: Buffer(Float32 LE) → pgvector literal
//   - dialect fixes: HAVING alias, qualified ON CONFLICT update, GROUP BY 1
const { q, one, many, withTransaction, getPool, healthCheck, close } = require('./lib/db-pg');
const { DDL, NOW_TEXT } = require('./db-pg-schema');

// TEXT timestamp expressions matching SQLite semantics.
const NOW = NOW_TEXT; // 'YYYY-MM-DD HH24:MI:SS' UTC
const nowPlus = (interval) => `to_char(now() AT TIME ZONE 'UTC' + interval '${interval}', 'YYYY-MM-DD HH24:MI:SS')`;

function bufferToVecLiteral(buf) {
  if (typeof buf === 'string') return buf; // already a literal
  const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  return '[' + Array.from(v).join(',') + ']';
}

// Statement factory. paramNames = array → named-object call style (like
// better-sqlite3 @named params); null → positional. transforms maps a param
// name/index to a value converter.
function stmt(text, paramNames = null, transforms = null) {
  const toArray = (args) => {
    let arr;
    if (paramNames) {
      const obj = args[0] || {};
      arr = paramNames.map((k) => {
        let v = obj[k];
        if (v === undefined) v = null;
        if (transforms && transforms[k]) v = v === null ? null : transforms[k](v);
        return v;
      });
    } else {
      arr = args.map((v, i) => {
        if (v === undefined) v = null;
        if (transforms && transforms[i]) v = v === null ? null : transforms[i](v);
        return v;
      });
    }
    return arr;
  };
  return {
    get: async (...args) => one(text, toArray(args)),
    all: async (...args) => many(text, toArray(args)),
    run: async (...args) => {
      const r = await q(text, toArray(args));
      return { changes: r.rowCount || 0, lastInsertRowid: r.rows?.[0]?.id ?? null };
    },
  };
}

const sql = {
  // ─── users ───────────────────────────────────────────────
  insertUser: stmt(
    `INSERT INTO users (email, password_hash, name, role, company_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['email', 'password_hash', 'name', 'role', 'company_id'],
  ),
  listClientsForCompany: stmt(
    `SELECT id, email, name, created_at, last_login_at
       FROM users WHERE role = 'client' AND company_id = $1
      ORDER BY created_at DESC`,
  ),
  deleteUser    : stmt(`DELETE FROM users WHERE id = $1`),
  getUserByEmail: stmt(`SELECT * FROM users WHERE lower(email) = lower($1)`),
  getUserById   : stmt(`SELECT id, email, name, role, company_id, created_at, last_login_at FROM users WHERE id = $1`),
  countUsers    : stmt(`SELECT COUNT(*)::int AS n FROM users`),
  bumpFailedLogin: stmt(`
    UPDATE users
       SET failed_logins = failed_logins + 1,
           locked_until  = CASE
             WHEN failed_logins + 1 = 3 THEN ${nowPlus('30 seconds')}
             WHEN failed_logins + 1 = 4 THEN ${nowPlus('2 minutes')}
             WHEN failed_logins + 1 = 5 THEN ${nowPlus('15 minutes')}
             WHEN failed_logins + 1 >= 6 THEN ${nowPlus('1 hour')}
             ELSE locked_until
           END
     WHERE id = $1`),
  clearFailedLogins: stmt(
    `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ${NOW} WHERE id = $1`,
  ),
  updatePassword: stmt(`UPDATE users SET password_hash = $1 WHERE id = $2`),
  getUserPasswordHash: stmt(`SELECT password_hash FROM users WHERE id = $1`),

  // ─── sessions ────────────────────────────────────────────
  insertSession: stmt(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, ${NOW})`,
    ['id', 'user_id', 'expires_at', 'user_agent', 'ip'],
  ),
  getSessionById: stmt(`
    SELECT s.*, u.id AS uid, u.email, u.name AS user_name, u.role, u.company_id, u.locked_until
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at::timestamptz > now()`),
  touchSession: stmt(`UPDATE sessions SET last_seen_at = ${NOW} WHERE id = $1`),
  touchAndExtendSession: stmt(`UPDATE sessions SET last_seen_at = ${NOW}, expires_at = $1 WHERE id = $2`),
  deleteSession: stmt(`DELETE FROM sessions WHERE id = $1`),
  deleteUserSessions: stmt(`DELETE FROM sessions WHERE user_id = $1`),
  purgeExpired: stmt(`DELETE FROM sessions WHERE expires_at::timestamptz <= now()`),

  // ─── auth events / audit ─────────────────────────────────
  logAuthEvent: stmt(
    `INSERT INTO auth_events (user_id, email, event_type, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    ['user_id', 'email', 'event_type', 'ip', 'user_agent'],
  ),
  logAuditEvent: stmt(
    `INSERT INTO audit_events (actor_id, actor_email, action, resource, metadata, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['actor_id', 'actor_email', 'action', 'resource', 'metadata', 'ip', 'user_agent'],
  ),

  // ─── usage counters ──────────────────────────────────────
  bumpUsage: stmt(
    `INSERT INTO usage_counters (company_id, day, kind, amount) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, day, kind)
     DO UPDATE SET amount = usage_counters.amount + excluded.amount`,
    ['company_id', 'day', 'kind', 'amount'],
  ),
  getUsage: stmt(`SELECT amount FROM usage_counters WHERE company_id = $1 AND day = $2 AND kind = $3`),
  countSuperadmins: stmt(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'superadmin'`),

  // ─── webhook inbox ───────────────────────────────────────
  insertWebhookEvent: stmt(
    `INSERT INTO webhook_events (provider, event_id, event_type, raw_body, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    ['provider', 'event_id', 'event_type', 'raw_body'],
  ),
  markWebhookProcessed: stmt(`UPDATE webhook_events SET status = 'processed', processed_at = ${NOW} WHERE id = $1`),
  markWebhookFailed: stmt(`
    UPDATE webhook_events
       SET status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
           attempts = attempts + 1,
           last_error = $1
     WHERE id = $2`),
  listPendingWebhooks: stmt(`
    SELECT * FROM webhook_events
     WHERE status = 'pending' AND attempts < 5
     ORDER BY received_at ASC LIMIT $1`),
  countWebhooksByStatus: stmt(`SELECT COUNT(*)::int AS n FROM webhook_events WHERE status = $1`),

  // ─── companies ───────────────────────────────────────────
  listCompanies: stmt(`SELECT * FROM companies ORDER BY created_at DESC`),
  getCompany   : stmt(`SELECT * FROM companies WHERE id = $1`),
  companyExists: stmt(`SELECT 1 AS one FROM companies WHERE id = $1`),
  claimOrphanCompanies: stmt(`UPDATE companies SET user_id = $1 WHERE user_id IS NULL`),
  insertCompany: stmt(
    `INSERT INTO companies (id, user_id, name, language, voice_id, phone_number, assistant_id, system_prompt, kb_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    ['id', 'user_id', 'name', 'language', 'voice_id', 'phone_number', 'assistant_id', 'system_prompt', 'kb_text'],
  ),
  updateCompanySettings: stmt(
    `UPDATE companies SET settings = $1, updated_at = ${NOW} WHERE id = $2`,
    ['settings', 'id'],
  ),
  updateCompany: stmt(
    `UPDATE companies SET
       name = $1, language = $2, voice_id = $3, phone_number = $4,
       assistant_id = $5, system_prompt = $6, kb_text = $7, updated_at = ${NOW}
     WHERE id = $8`,
    ['name', 'language', 'voice_id', 'phone_number', 'assistant_id', 'system_prompt', 'kb_text', 'id'],
  ),
  deleteCompany: stmt(`DELETE FROM companies WHERE id = $1`),
  companyByAssistantId: stmt(`SELECT id FROM companies WHERE assistant_id = $1 OR assistant_id_inbound = $1`),
  companyByPhoneNumberId: stmt(`
    SELECT id FROM companies
     WHERE settings IS NOT NULL
       AND (settings::jsonb->>'inboundPhoneNumberId'  = $1
        OR  settings::jsonb->>'outboundPhoneNumberId' = $1)`),
  setCompanySynced: stmt(
    `UPDATE companies SET assistant_id = $1, last_synced_at = ${NOW}, updated_at = ${NOW} WHERE id = $2`,
  ),
  setCompanyInboundAssistant: stmt(
    `UPDATE companies SET assistant_id_inbound = $1, updated_at = ${NOW} WHERE id = $2`,
    ['aid', 'id'],
  ),
  listCompanyIdNames: stmt(`SELECT id, name FROM companies`),
  getCompanyIdName  : stmt(`SELECT id, name FROM companies WHERE id = $1`),
  companiesStats: stmt(`
    SELECT c.id AS company_id,
      (SELECT COUNT(DISTINCT session_id)::int FROM chats WHERE company_id = c.id) AS chats,
      (SELECT COUNT(*)::int FROM calls WHERE company_id = c.id) AS calls,
      (SELECT MAX(ts) FROM (
        SELECT MAX(created_at) AS ts FROM chats WHERE company_id = c.id
        UNION ALL
        SELECT MAX(created_at) AS ts FROM calls WHERE company_id = c.id
      ) x) AS last_activity
    FROM companies c`),

  // ─── chats ───────────────────────────────────────────────
  insertChat: stmt(
    `INSERT INTO chats (company_id, session_id, user_message, assistant_reply, channel, latency_ms, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['company_id', 'session_id', 'user_message', 'assistant_reply', 'channel', 'latency_ms', 'user_id'],
  ),
  listChatsForCompany: stmt(`SELECT * FROM chats WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`),
  listSessionsForCompany: stmt(`
    SELECT session_id,
           COUNT(*)::int    AS messages,
           MAX(created_at)  AS last_at,
           MAX(summary)     AS summary
      FROM chats WHERE company_id = $1
     GROUP BY session_id
     ORDER BY last_at DESC
     LIMIT $2`),
  getSession: stmt(`SELECT * FROM chats WHERE session_id = $1 ORDER BY created_at ASC`),
  setSessionSummary: stmt(`UPDATE chats SET summary = $1 WHERE session_id = $2`),

  // ─── calls ───────────────────────────────────────────────
  upsertCall: stmt(
    `INSERT INTO calls (id, company_id, assistant_id, caller_number, duration_sec, started_at, ended_at, ended_reason, transcript, summary, cost_usd, direction, recording_url, structured_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO UPDATE SET
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
       structured_data = COALESCE(excluded.structured_data, calls.structured_data)`,
    ['id', 'company_id', 'assistant_id', 'caller_number', 'duration_sec', 'started_at', 'ended_at',
     'ended_reason', 'transcript', 'summary', 'cost_usd', 'direction', 'recording_url', 'structured_data'],
  ),
  insertOutboundCallStub: stmt(
    `INSERT INTO calls (id, company_id, assistant_id, caller_number, started_at, direction)
     VALUES ($1, $2, $3, $4, ${NOW}, 'outbound')
     ON CONFLICT (id) DO NOTHING`,
    ['id', 'company_id', 'assistant_id', 'caller_number'],
  ),
  setCallSummary: stmt(`UPDATE calls SET summary = $1 WHERE id = $2`),
  listCallsForCompany: stmt(`SELECT * FROM calls WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`),
  listAllCalls: stmt(`SELECT * FROM calls ORDER BY created_at DESC LIMIT $1`),
  getCall: stmt(`SELECT * FROM calls WHERE id = $1`),

  // ─── RAG: documents + chunks ─────────────────────────────
  insertDocument: stmt(
    `INSERT INTO kb_documents (company_id, filename, mime_type, size_bytes, raw_text, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['company_id', 'filename', 'mime_type', 'size_bytes', 'raw_text', 'raw_data'],
  ),
  insertChunk: stmt(
    `INSERT INTO kb_chunks (company_id, document_id, chunk_index, text, embedding, token_count)
     VALUES ($1, $2, $3, $4, $5::vector, $6)`,
    ['company_id', 'document_id', 'chunk_index', 'text', 'embedding', 'token_count'],
    { embedding: bufferToVecLiteral },
  ),
  listDocuments: stmt(`
    SELECT d.id, d.filename, d.mime_type, d.size_bytes, d.created_at,
           (SELECT COUNT(*)::int FROM kb_chunks WHERE document_id = d.id) AS chunk_count
      FROM kb_documents d
     WHERE d.company_id = $1 AND d.deleted_at IS NULL
     ORDER BY d.created_at DESC`),
  getDocument: stmt(`SELECT * FROM kb_documents WHERE id = $1 AND deleted_at IS NULL`),
  deleteDocument: stmt(`UPDATE kb_documents SET deleted_at = ${NOW} WHERE id = $1 AND deleted_at IS NULL`),
  purgeDocumentChunks: stmt(`DELETE FROM kb_chunks WHERE document_id = $1`),
  countCompanyChunks: stmt(`SELECT COUNT(*)::int AS n FROM kb_chunks WHERE company_id = $1`),
  listCompanyChunks: stmt(`
    SELECT id, document_id, chunk_index, text, embedding::text AS embedding
      FROM kb_chunks WHERE company_id = $1`),
  listChunksForDoc: stmt(`
    SELECT id, chunk_index, text, token_count
      FROM kb_chunks WHERE document_id = $1 ORDER BY chunk_index ASC`),
  listAllChunksForCompany: stmt(`
    SELECT c.id, c.document_id, c.chunk_index, c.text, d.filename
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
     WHERE c.company_id = $1 AND d.deleted_at IS NULL
     ORDER BY d.id ASC, c.chunk_index ASC`),

  // ─── scenarios ───────────────────────────────────────────
  insertScenario: stmt(
    `INSERT INTO scenarios (
       company_id, name, description, first_message, first_message_inbound,
       instruction_prompt, success_criteria, variables, is_active, language,
       knowledge_base_ids
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    ['company_id', 'name', 'description', 'first_message', 'first_message_inbound',
     'instruction_prompt', 'success_criteria', 'variables', 'is_active', 'language',
     'knowledge_base_ids'],
  ),
  updateScenario: stmt(
    `UPDATE scenarios SET
       name = $1, description = $2, first_message = $3, first_message_inbound = $4,
       instruction_prompt = $5, success_criteria = $6, variables = $7,
       is_active = $8, language = $9, knowledge_base_ids = $10, updated_at = ${NOW}
     WHERE id = $11 AND deleted_at IS NULL`,
    ['name', 'description', 'first_message', 'first_message_inbound', 'instruction_prompt',
     'success_criteria', 'variables', 'is_active', 'language', 'knowledge_base_ids', 'id'],
  ),
  setScenarioInboundPrompt: stmt(
    `UPDATE scenarios SET instruction_prompt_inbound = $1, updated_at = ${NOW}
      WHERE id = $2 AND deleted_at IS NULL`,
    ['v', 'id'],
  ),
  listScenarios: stmt(`
    SELECT id, company_id, name, description, language, is_active,
           created_at, updated_at, success_criteria
      FROM scenarios
     WHERE company_id = $1 AND deleted_at IS NULL
     ORDER BY updated_at DESC`),
  listDeletedScenarios: stmt(`
    SELECT id, name, language, deleted_at
      FROM scenarios
     WHERE company_id = $1 AND deleted_at IS NOT NULL
     ORDER BY deleted_at DESC`),
  getScenario: stmt(`SELECT * FROM scenarios WHERE id = $1 AND deleted_at IS NULL`),
  getActiveScenarioForCompany: stmt(`
    SELECT * FROM scenarios
     WHERE company_id = $1 AND is_active = 1 AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`),
  setScenarioActive: stmt(
    `UPDATE scenarios SET is_active = $1, updated_at = ${NOW}
      WHERE id = $2 AND deleted_at IS NULL`,
    ['is_active', 'id'],
  ),
  deactivateAllScenariosForCompany: stmt(
    `UPDATE scenarios
        SET is_active = 0, updated_at = ${NOW}
      WHERE company_id = $1 AND id != $2 AND is_active = 1 AND deleted_at IS NULL`,
    ['company_id', 'except_id'],
  ),
  softDeleteScenario: stmt(
    `UPDATE scenarios SET deleted_at = ${NOW}, is_active = 0
      WHERE id = $1 AND deleted_at IS NULL`,
  ),
  listCompaniesWithMultipleActives: stmt(`
    SELECT company_id, COUNT(*)::int AS n
      FROM scenarios
     WHERE is_active = 1 AND deleted_at IS NULL
     GROUP BY company_id
     HAVING COUNT(*) > 1`),
  pickNewestActiveScenarioId: stmt(`
    SELECT id FROM scenarios
     WHERE company_id = $1 AND is_active = 1 AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`),
  restoreScenario: stmt(`UPDATE scenarios SET deleted_at = NULL WHERE id = $1`),

  // ─── scenario versions ───────────────────────────────────
  insertScenarioVersion: stmt(
    `INSERT INTO scenario_versions
       (scenario_id, name, first_message, first_message_inbound, instruction_prompt, edited_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['scenario_id', 'name', 'first_message', 'first_message_inbound', 'instruction_prompt', 'edited_by'],
  ),
  listScenarioVersions: stmt(`
    SELECT id, name, edited_by, created_at,
           length(instruction_prompt)::int AS prompt_len
      FROM scenario_versions
     WHERE scenario_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 30`),
  getScenarioVersion: stmt(`SELECT * FROM scenario_versions WHERE id = $1`),
  pruneScenarioVersions: stmt(`
    DELETE FROM scenario_versions
     WHERE scenario_id = $1
       AND id NOT IN (
         SELECT id FROM scenario_versions
          WHERE scenario_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 30
       )`),

  // ─── whatsapp sessions (agent API continuity) ────────────
  getWhatsappSession: stmt(`
    SELECT vapi_chat_id FROM whatsapp_sessions
     WHERE company_id = $1 AND customer_phone = $2`),
  upsertWhatsappSession: stmt(
    `INSERT INTO whatsapp_sessions (company_id, customer_phone, vapi_chat_id, updated_at)
     VALUES ($1, $2, $3, ${NOW})
     ON CONFLICT (company_id, customer_phone) DO UPDATE
        SET vapi_chat_id = excluded.vapi_chat_id, updated_at = ${NOW}`,
    ['company_id', 'customer_phone', 'vapi_chat_id'],
  ),

  // ─── api keys ────────────────────────────────────────────
  insertApiKey: stmt(
    `INSERT INTO api_keys (company_id, name, key_hash, prefix)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['company_id', 'name', 'key_hash', 'prefix'],
  ),
  listApiKeysForCompany: stmt(`
    SELECT id, name, prefix, created_at, last_used_at, revoked_at
      FROM api_keys WHERE company_id = $1 ORDER BY created_at DESC`),
  getApiKeyByHash: stmt(`
    SELECT k.*, c.id AS company_exists
      FROM api_keys k JOIN companies c ON c.id = k.company_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`),
  touchApiKey: stmt(`UPDATE api_keys SET last_used_at = ${NOW} WHERE id = $1`),
  revokeApiKey: stmt(`
    UPDATE api_keys SET revoked_at = ${NOW}
     WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL`),

  // ─── dashboard analytics ─────────────────────────────────
  countCallsInRange: stmt(
    `SELECT COUNT(*)::int AS n FROM calls
      WHERE created_at BETWEEN $1 AND $2
        AND ($3::text IS NULL OR company_id = $3)`,
    ['from', 'to', 'company_id'],
  ),
  avgCallDurationInRange: stmt(
    `SELECT AVG(duration_sec) AS avg_dur FROM calls
      WHERE created_at BETWEEN $1 AND $2
        AND duration_sec IS NOT NULL AND duration_sec > 0
        AND ($3::text IS NULL OR company_id = $3)`,
    ['from', 'to', 'company_id'],
  ),
  callSuccessRateInRange: stmt(
    `SELECT
       SUM(CASE
             WHEN duration_sec >= 10
              AND COALESCE(ended_reason,'') NOT IN ('error','failed','no-answer','silence-timed-out','customer-did-not-give-microphone-permission')
           THEN 1 ELSE 0 END)::int AS ok,
       COUNT(*)::int AS total
     FROM calls
     WHERE created_at BETWEEN $1 AND $2
       AND ($3::text IS NULL OR company_id = $3)`,
    ['from', 'to', 'company_id'],
  ),
  countChatSessionsInRange: stmt(
    `SELECT COUNT(DISTINCT session_id)::int AS n FROM chats
      WHERE created_at BETWEEN $1 AND $2
        AND ($3::text IS NULL OR company_id = $3)`,
    ['from', 'to', 'company_id'],
  ),
  countActiveCompanies: stmt(
    `SELECT COUNT(DISTINCT id)::int AS n FROM companies
      WHERE assistant_id IS NOT NULL
        AND ($1::text IS NULL OR id = $1)`,
    ['company_id'],
  ),
  callsPerHourInRange: stmt(
    `SELECT substr(created_at, 12, 2) AS hour,
            COALESCE(direction, 'inbound') AS direction,
            COUNT(*)::int AS n
       FROM calls
      WHERE created_at BETWEEN $1 AND $2
        AND ($3::text IS NULL OR company_id = $3)
      GROUP BY 1, 2`,
    ['from', 'to', 'company_id'],
  ),
  chatsPerHourInRange: stmt(
    `SELECT substr(created_at, 12, 2) AS hour, COUNT(*)::int AS n
       FROM chats
      WHERE created_at BETWEEN $1 AND $2
        AND ($3::text IS NULL OR company_id = $3)
      GROUP BY 1`,
    ['from', 'to', 'company_id'],
  ),
};

// ─── Generic query API (dynamic SQL: IN lists, optional clauses) ──
// Accepts '?' placeholders (sqlite style) and converts to $n.
function qmarksToDollar(text) {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}
const get = (text, params = []) => one(qmarksToDollar(text), params);
const all = (text, params = []) => many(qmarksToDollar(text), params);
const run = async (text, params = []) => {
  const r = await q(qmarksToDollar(text), params);
  return { changes: r.rowCount || 0, lastInsertRowid: r.rows?.[0]?.id ?? null };
};

// Boot: ensure schema exists (idempotent; the real data arrives via
// scripts/migrate-to-pg.js at cutover, but a fresh DB must also boot clean).
async function initDb() {
  await q(DDL);
  await q(`CREATE INDEX IF NOT EXISTS idx_kbchunks_embedding
           ON kb_chunks USING hnsw (embedding vector_cosine_ops)`);
}

module.exports = {
  db: null,                     // no raw better-sqlite3 handle under pg
  sql, get, all, run,
  withTransaction, initDb, healthCheck, close, getPool,
  isPg: true,
};
