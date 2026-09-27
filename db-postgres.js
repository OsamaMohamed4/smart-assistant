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
  // Park an event we can no longer process (e.g. a Vapi event still pending in
  // the inbox when the Vapi driver was removed). The raw body is preserved —
  // only the status changes, so nothing is lost and the drain stops retrying
  // forever. 'skipped' is deliberately neither 'pending' nor 'failed', so it
  // drops out of the /health backlog counters instead of alerting.
  markWebhookSkipped: stmt(`
    UPDATE webhook_events
       SET status = 'skipped', last_error = $1, processed_at = ${NOW}
     WHERE id = $2`),
  countWebhooksByStatus: stmt(`SELECT COUNT(*)::int AS n FROM webhook_events WHERE status = $1`),

  // ─── companies ───────────────────────────────────────────
  listCompanies: stmt(`SELECT * FROM companies ORDER BY created_at DESC`),
  getCompany   : stmt(`SELECT * FROM companies WHERE id = $1`),
  companyExists: stmt(`SELECT 1 AS one FROM companies WHERE id = $1`),
  claimOrphanCompanies: stmt(`UPDATE companies SET user_id = $1 WHERE user_id IS NULL`),
  // The provider's agent id is NOT settable through company CRUD — it is owned
  // by the voice sync (setCompanySynced), so a stray PUT can never point a
  // company at another tenant's agent.
  insertCompany: stmt(
    `INSERT INTO companies (id, user_id, name, language, voice_id, phone_number, system_prompt, kb_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    ['id', 'user_id', 'name', 'language', 'voice_id', 'phone_number', 'system_prompt', 'kb_text'],
  ),
  updateCompanySettings: stmt(
    `UPDATE companies SET settings = $1, updated_at = ${NOW} WHERE id = $2`,
    ['settings', 'id'],
  ),
  updateCompany: stmt(
    `UPDATE companies SET
       name = $1, language = $2, voice_id = $3, phone_number = $4,
       system_prompt = $5, kb_text = $6, updated_at = ${NOW}
     WHERE id = $7`,
    ['name', 'language', 'voice_id', 'phone_number', 'system_prompt', 'kb_text', 'id'],
  ),
  deleteCompany: stmt(`DELETE FROM companies WHERE id = $1`),
  // A company may run two agents (outbound + optional inbound), so an event's
  // agent id has to be matched against both.
  companyByAgentId: stmt(
    `SELECT id FROM companies WHERE elevenlabs_agent_id = $1 OR elevenlabs_agent_id_inbound = $1`),
  // Agent ids change whenever an agent is recreated, which would orphan calls
  // placed by the previous one. The imported phone number id is stable.
  companyByProviderPhoneNumberId: stmt(
    `SELECT id FROM companies WHERE elevenlabs_phone_number_id = $1`),
  // Last resort: the E.164 number, i.e. the 3CX DID, which outlives every
  // provider-side identifier.
  companyByPhoneNumber: stmt(`SELECT id FROM companies WHERE phone_number = $1`),
  setCompanySynced: stmt(
    `UPDATE companies
        SET elevenlabs_agent_id = $1, voice_provider = 'elevenlabs',
            elevenlabs_synced_at = ${NOW}, last_synced_at = ${NOW}, updated_at = ${NOW}
      WHERE id = $2`,
  ),
  setCompanyElevenLabsPhone: stmt(
    `UPDATE companies
        SET elevenlabs_phone_number_id = $1,
            phone_number = COALESCE($2, phone_number),
            updated_at = ${NOW}
      WHERE id = $3`,
    ['phone_number_id', 'phone_number', 'id'],
  ),
  // Moving a number to a new company must first release it from the old one,
  // or both rows claim it and no inbound call on that number can be attributed.
  // Scoped to THIS number and excluding the new owner — the whole point is not
  // to touch any other company's row. (The previous provider's bind-phone flow
  // did the same thing; it is preserved here because the reason still holds.)
  clearPhoneNumberOwner: stmt(
    `UPDATE companies SET phone_number = NULL, updated_at = ${NOW}
      WHERE phone_number = $1 AND id <> $2`,
    ['value', 'keep'],
  ),
  clearElevenLabsPhoneOwner: stmt(
    `UPDATE companies SET elevenlabs_phone_number_id = NULL, updated_at = ${NOW}
      WHERE elevenlabs_phone_number_id = $1 AND id <> $2`,
    ['value', 'keep'],
  ),
  setCompanyKbTool: stmt(
    `UPDATE companies SET elevenlabs_kb_tool_id = $1, updated_at = ${NOW} WHERE id = $2`,
    ['tool_id', 'id'],
  ),
  setCompanyBusinessProfile: stmt(
    `UPDATE companies SET business_profile = $1, updated_at = ${NOW} WHERE id = $2`,
    ['business_profile', 'id'],
  ),

  // ─── Capabilities ───────────────────────────────────────────────
  listCompanyFeatures: stmt(
    `SELECT feature_key, enabled, config FROM company_features WHERE company_id = $1`,
  ),
  getCompanyFeature: stmt(
    `SELECT feature_key, enabled, config FROM company_features WHERE company_id = $1 AND feature_key = $2`,
  ),
  upsertCompanyFeature: stmt(
    `INSERT INTO company_features (company_id, feature_key, enabled, config)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, feature_key) DO UPDATE SET
       enabled    = excluded.enabled,
       config     = excluded.config,
       updated_at = ${NOW}`,
    ['company_id', 'feature_key', 'enabled', 'config'],
  ),
  // Provider tool ids, one row per capability. The composite key is what makes
  // re-publishing update rather than duplicate.
  listCompanyTools: stmt(
    `SELECT feature_key, elevenlabs_tool_id, config_hash FROM company_tools WHERE company_id = $1`,
  ),
  upsertCompanyTool: stmt(
    `INSERT INTO company_tools (company_id, feature_key, elevenlabs_tool_id, config_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, feature_key) DO UPDATE SET
       elevenlabs_tool_id = excluded.elevenlabs_tool_id,
       config_hash        = excluded.config_hash,
       synced_at          = ${NOW}`,
    ['company_id', 'feature_key', 'elevenlabs_tool_id', 'config_hash'],
  ),
  deleteCompanyTool: stmt(
    `DELETE FROM company_tools WHERE company_id = $1 AND feature_key = $2`,
    ['company_id', 'feature_key'],
  ),

  // ─── Publish pipeline ───────────────────────────────────────────
  // A run is opened BEFORE any provider call so a process that dies mid-publish
  // still leaves evidence of what was attempted. RETURNING id because pg has no
  // lastInsertRowid.
  insertPublishRun: stmt(
    `INSERT INTO company_publish_runs (company_id, status, scenario_id, actor_email)
     VALUES ($1, 'running', $2, $3) RETURNING id`,
    ['company_id', 'scenario_id', 'actor_email'],
  ),
  finishPublishRun: stmt(
    `UPDATE company_publish_runs
        SET status = $1, steps = $2, error = $3, failed_step = $4,
            agent_id = $5, finished_at = ${NOW}
      WHERE id = $6`,
    ['status', 'steps', 'error', 'failed_step', 'agent_id', 'id'],
  ),
  getLastPublishRun: stmt(
    `SELECT * FROM company_publish_runs WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
  ),
  // Mirrors the run's outcome onto the company so the UI can badge it without
  // joining the history table on every list render.
  setCompanyPublishStatus: stmt(
    `UPDATE companies
        SET publish_status = $1,
            published_at   = CASE WHEN $1 = 'published' THEN ${NOW} ELSE published_at END,
            updated_at     = ${NOW}
      WHERE id = $2`,
    ['status', 'id'],
  ),
  setCompanyInboundAssistant: stmt(
    `UPDATE companies SET elevenlabs_agent_id_inbound = $1, updated_at = ${NOW} WHERE id = $2`,
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
  // Both are company-scoped: session_id alone is a guessable key, so the
  // tenant is always part of the predicate (belt to the route guard's braces).
  getSession: stmt(`SELECT * FROM chats WHERE session_id = $1 AND company_id = $2 ORDER BY created_at ASC`),
  // Bounded variant for the LLM prompt path — see the note in db-sqlite.js.
  getSessionRecent: stmt(`SELECT * FROM chats WHERE session_id = $1 AND company_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3`),
  setSessionSummary: stmt(`UPDATE chats SET summary = $1 WHERE session_id = $2 AND company_id = $3`),

  // ─── calls ───────────────────────────────────────────────
  // `assistant_id` holds the provider's agent identifier (ElevenLabs agent_id
  // today, a Vapi assistant id on historical rows). The column name predates
  // the provider migration and is kept so no historical row has to be rewritten.
  // WRITE RULE: a later event may FILL a field or CORRECT it, but must never
  // blank one. Provider events are partial and unordered — a
  // call_initiation_failure carries no caller number, start time or duration,
  // and may carry no agent id to resolve a company from. Assigning those
  // straight from `excluded` let one sparse event erase what an earlier
  // complete event (or the outbound stub) had already established: the
  // customer's number, the call's start time, even its company_id — which
  // under row-level security makes the row vanish from the tenant that owns
  // it. So EVERY column coalesces onto its current value.
  upsertCall: stmt(
    `INSERT INTO calls (id, company_id, assistant_id, caller_number, duration_sec, started_at, ended_at, ended_reason, transcript, summary, cost_usd, direction, recording_url, structured_data, provider, provider_call_ref, has_recording, cost_credits)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, 'inbound'), $13, $14, $15, $16, COALESCE($17, 0), $18)
     ON CONFLICT (id) DO UPDATE SET
       company_id    = COALESCE(excluded.company_id, calls.company_id),
       assistant_id  = COALESCE(excluded.assistant_id, calls.assistant_id),
       caller_number = COALESCE(excluded.caller_number, calls.caller_number),
       duration_sec  = COALESCE(excluded.duration_sec, calls.duration_sec),
       started_at    = COALESCE(excluded.started_at, calls.started_at),
       ended_at      = COALESCE(excluded.ended_at, calls.ended_at),
       ended_reason  = COALESCE(excluded.ended_reason, calls.ended_reason),
       transcript    = COALESCE(excluded.transcript, calls.transcript),
       summary       = COALESCE(excluded.summary, calls.summary),
       cost_usd      = COALESCE(excluded.cost_usd, calls.cost_usd),
       cost_credits  = COALESCE(excluded.cost_credits, calls.cost_credits),
       -- direction is NOT NULL, so "the provider didn't say" cannot travel via
       -- excluded.direction (the INSERT would have had to bind NULL into a NOT
       -- NULL column). Read the PARAMETER instead: NULL means keep what the row
       -- already has — which is what stops an outbound stub being relabelled
       -- inbound by a late event that omits direction.
       direction     = CASE WHEN $12::text IS NULL THEN calls.direction ELSE $12 END,
       recording_url = COALESCE(excluded.recording_url, calls.recording_url),
       structured_data = COALESCE(excluded.structured_data, calls.structured_data),
       provider      = COALESCE(excluded.provider, calls.provider),
       provider_call_ref = COALESCE(excluded.provider_call_ref, calls.provider_call_ref),
       -- Latches on: audio appearing is news, its absence in a partial event is not.
       has_recording = CASE WHEN $17::int = 1 THEN 1 ELSE calls.has_recording END`,
    ['id', 'company_id', 'assistant_id', 'caller_number', 'duration_sec', 'started_at', 'ended_at',
     'ended_reason', 'transcript', 'summary', 'cost_usd', 'direction', 'recording_url', 'structured_data',
     'provider', 'provider_call_ref', 'has_recording', 'cost_credits'],
  ),
  insertOutboundCallStub: stmt(
    `INSERT INTO calls (id, company_id, assistant_id, caller_number, started_at, direction, provider, provider_call_ref)
     VALUES ($1, $2, $3, $4, ${NOW}, 'outbound', $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    ['id', 'company_id', 'assistant_id', 'caller_number', 'provider', 'provider_call_ref'],
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
     VALUES ($1, $2, $3, $4, $5::vector, $6) RETURNING id`,
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
  listCompanyChunkTexts: stmt(`
    SELECT id, document_id, text FROM kb_chunks WHERE company_id = $1`),
  updateChunkEmbedding: stmt(
    `UPDATE kb_chunks SET embedding = $1::vector WHERE id = $2`,
    ['embedding', 'id'],
    { embedding: bufferToVecLiteral },
  ),
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
  // company_id denormalized from the parent scenario so RLS covers version
  // history too (it mirrors the full prompt text). See lib/migrations-pg.js.
  insertScenarioVersion: stmt(
    `INSERT INTO scenario_versions
       (scenario_id, company_id, name, first_message, first_message_inbound, instruction_prompt, edited_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    ['scenario_id', 'company_id', 'name', 'first_message', 'first_message_inbound', 'instruction_prompt', 'edited_by'],
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

  // ─── whatsapp sessions (legacy) ──────────────────────────
  // Read-only, and nothing reads it today. The public Agent API used to resume
  // a text thread through a provider-issued chat id stored here; it now rebuilds
  // history from `chats` (sql.getSession), which cannot expire. The table and
  // this accessor are kept so historical rows remain inspectable — there is no
  // writer any more, deliberately.
  getWhatsappSession: stmt(`
    SELECT vapi_chat_id FROM whatsapp_sessions
     WHERE company_id = $1 AND customer_phone = $2`),

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

  // ─── Campaigns (outbound dialer) ─────────────────────────
  insertCampaign: stmt(
    `INSERT INTO campaigns (company_id, name, status, start_hour, start_minute, end_hour, end_minute, max_concurrent, max_attempts, retry_delay_min, created_by)
     VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    ['company_id', 'name', 'start_hour', 'start_minute', 'end_hour', 'end_minute', 'max_concurrent', 'max_attempts', 'retry_delay_min', 'created_by'],
  ),
  // Campaign report: one round trip joining every contact to its call row.
  // LEFT JOIN because a contact may not have been dialled yet, or the
  // end-of-call webhook may not have landed. All report fields come from
  // here — no second query, no AI pass.
  campaignReportRows: stmt(`
    SELECT cc.id, cc.phone, cc.name, cc.status, cc.attempts, cc.last_attempt_at,
           cc.call_id, cc.last_error, cc.created_at,
           c.duration_sec, c.started_at AS call_started_at, c.ended_at AS call_ended_at,
           c.ended_reason, c.summary, c.structured_data, c.recording_url
      FROM campaign_contacts cc
      LEFT JOIN calls c ON c.id = cc.call_id
     WHERE cc.campaign_id = $1
     ORDER BY cc.id ASC`),
  getCampaign: stmt(`SELECT * FROM campaigns WHERE id = $1`),
  listCampaignsForCompany: stmt(`SELECT * FROM campaigns WHERE company_id = $1 ORDER BY created_at DESC`),
  listRunningCampaigns: stmt(`SELECT * FROM campaigns WHERE status = 'running'`),
  setCampaignStatus: stmt(
    `UPDATE campaigns SET status = $1, updated_at = ${NOW} WHERE id = $2`,
    ['status', 'id'],
  ),
  startCampaign: stmt(`
    UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ${NOW}), updated_at = ${NOW}
     WHERE id = $1 AND status IN ('draft','paused')`),
  completeCampaign: stmt(`
    UPDATE campaigns SET status = 'completed', completed_at = ${NOW}, updated_at = ${NOW} WHERE id = $1`),
  // company_id is denormalized from the parent campaign so RLS can police this
  // table directly (it holds customer phone numbers). Written on insert, and
  // backfilled for pre-existing rows by lib/migrations-pg.js.
  insertCampaignContact: stmt(
    `INSERT INTO campaign_contacts (campaign_id, company_id, phone, name, variables)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['campaign_id', 'company_id', 'phone', 'name', 'variables'],
  ),
  listCampaignContacts: stmt(`SELECT * FROM campaign_contacts WHERE campaign_id = $1 ORDER BY id ASC LIMIT $2`),
  campaignContactStats: stmt(`
    SELECT status, COUNT(*)::int AS n FROM campaign_contacts WHERE campaign_id = $1 GROUP BY status`),
  pickPendingContacts: stmt(`
    SELECT * FROM campaign_contacts WHERE campaign_id = $1 AND status = 'pending' ORDER BY id ASC LIMIT $2`),
  countCallingContacts: stmt(`
    SELECT COUNT(*)::int AS n FROM campaign_contacts WHERE campaign_id = $1 AND status = 'calling'`),
  countRemainingContacts: stmt(`
    SELECT COUNT(*)::int AS n FROM campaign_contacts
     WHERE campaign_id = $1 AND (status IN ('pending','calling')
        OR (status IN ('failed','no_answer') AND attempts < $2))`),
  claimContact: stmt(
    `UPDATE campaign_contacts
        SET status = 'calling', attempts = attempts + 1,
            last_attempt_at = $1, last_error = NULL
      WHERE id = $2 AND status = 'pending'`,
    ['at', 'id'],
  ),
  setContactCallId: stmt(
    `UPDATE campaign_contacts SET call_id = $1 WHERE id = $2`,
    ['call_id', 'id'],
  ),
  markContactError: stmt(
    `UPDATE campaign_contacts SET status = 'failed', last_error = $1 WHERE id = $2`,
    ['err', 'id'],
  ),
  updateContactByCallId: stmt(
    `UPDATE campaign_contacts SET status = $1, last_error = $2
      WHERE call_id = $3 AND status = 'calling'`,
    ['status', 'err', 'call_id'],
  ),
  requeueRetryContacts: stmt(`
    UPDATE campaign_contacts SET status = 'pending'
     WHERE campaign_id = $1 AND status IN ('failed','no_answer')
       AND attempts < $2 AND (last_attempt_at IS NULL OR last_attempt_at <= $3)`),
  requeueStaleCalling: stmt(`
    UPDATE campaign_contacts SET status = 'failed', last_error = 'timeout: no end-of-call report'
     WHERE campaign_id = $1 AND status = 'calling' AND last_attempt_at <= $2`),
  cancelCampaignContacts: stmt(`
    UPDATE campaign_contacts SET status = 'cancelled'
     WHERE campaign_id = $1 AND status IN ('pending','calling')`),

  // ─── Evals (golden questions + runs) ─────────────────────
  insertEvalQuestion: stmt(
    `INSERT INTO eval_questions (company_id, question, expected) VALUES ($1, $2, $3) RETURNING id`,
    ['company_id', 'question', 'expected'],
  ),
  listEvalQuestions: stmt(`SELECT * FROM eval_questions WHERE company_id = $1 ORDER BY id ASC`),
  deleteEvalQuestion: stmt(`DELETE FROM eval_questions WHERE id = $1 AND company_id = $2`),
  insertEvalRun: stmt(
    `INSERT INTO eval_runs (company_id, label, score, total, correct, partial, results)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    ['company_id', 'label', 'score', 'total', 'correct', 'partial', 'results'],
  ),
  listEvalRuns: stmt(`SELECT id, label, score, total, correct, partial, created_at FROM eval_runs WHERE company_id = $1 ORDER BY id DESC LIMIT 20`),
  getEvalRun: stmt(`SELECT * FROM eval_runs WHERE id = $1 AND company_id = $2`),

  // ─── Audit log (read side) ───────────────────────────────
  listAuditEvents: stmt(`
    SELECT id, actor_email, action, resource, metadata, ip, created_at
      FROM audit_events ORDER BY id DESC LIMIT $1`),

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
      WHERE elevenlabs_agent_id IS NOT NULL
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
  // Structural changes the IF NOT EXISTS DDL above cannot apply to an
  // existing database: denormalized company_id columns and the foreign keys
  // that were missing entirely on Postgres (audit F-03/F-05). Idempotent and
  // non-fatal — see lib/migrations-pg.js.
  const { runPgMigrations } = require('./lib/migrations-pg');
  await runPgMigrations(q);

  // Arm row-level security on any tenant table Postgres is not already
  // policing. Gated on RLS_ENABLED so a deployment that has not rolled RLS out
  // is left exactly as it was; where it HAS been rolled out, a newly added
  // tenant table now inherits the backstop instead of waiting for someone to
  // remember scripts/rls-migrate.js. Does no writes once everything is armed.
  //
  // Deliberately non-fatal. Losing the backstop is serious and is logged as an
  // error, but the application filter still stands, and taking the process down
  // over a catalog probe is how a deploy turns into an outage.
  if (process.env.RLS_ENABLED === '1') {
    try {
      const { armMissingRls } = require('./lib/rls');
      const armed = await armMissingRls({ query: (text, params) => q(text, params) });
      if (armed.length) {
        require('./lib/logger').logger.info('RLS armed on new tenant tables', { tables: armed });
      }
    } catch (e) {
      require('./lib/logger').logger.error(
        'RLS arming FAILED — tenant tables may lack the database backstop', { err: e.message },
      );
    }
  }
}

module.exports = {
  db: null,                     // no raw better-sqlite3 handle under pg
  sql, get, all, run,
  withTransaction, initDb, healthCheck, close, getPool,
  isPg: true,
};
