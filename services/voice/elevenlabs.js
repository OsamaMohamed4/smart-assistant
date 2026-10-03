// ElevenLabs Agents driver. The ONLY file in this repo that knows ElevenLabs
// URLs, field names or payload shapes. Everything else speaks the vocabulary in
// ./provider.js.
//
// Endpoints used (all verified against the live API reference):
//   POST   /v1/convai/agents/create                  create an agent
//   PATCH  /v1/convai/agents/{agent_id}              update an agent
//   GET    /v1/convai/agents/{agent_id}              existence check
//   GET    /v1/convai/agents                         recover an agent by name
//   POST   /v1/convai/tools                          create the KB webhook tool
//   PATCH  /v1/convai/tools/{tool_id}                update it
//   GET    /v1/convai/phone-numbers                  numbers this workspace owns
//   POST   /v1/convai/phone-numbers                  import a 3CX DID as a SIP trunk
//   PATCH  /v1/convai/phone-numbers/{id}             bind/update the number
//   POST   /v1/convai/sip-trunk/outbound-call        place an outbound call
//   GET    /v1/convai/conversations                  list recent conversations
//   GET    /v1/convai/conversations/{id}             one conversation in full
//   GET    /v1/convai/conversations/{id}/audio       the recording, as bytes
//
// Auth is the workspace key in the `xi-api-key` header. It never leaves this
// process — no route hands it to a browser.
const crypto = require('crypto');
const axios = require('axios');
const { logger } = require('../../lib/logger');
const { sql } = require('../../db');
const {
  toStamp, durationBetween, isE164, flattenTranscript,
} = require('./provider');

const API_BASE = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const TIMEOUT_MS = 20_000;
const NAME = 'elevenlabs';

// ─── HTTP ─────────────────────────────────────────────────────────
function apiKey() {
  const k = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!k) throw new Error('ELEVENLABS_API_KEY is not set');
  return k;
}

// Errors from this API arrive as {detail: ...} where detail is a string, an
// object, or FastAPI's array of validation errors. Flatten to one short string
// so it can be logged, bound to SQL, and shown to an operator unchanged —
// guessing at the cause has cost this project real debugging time before.
function errText(e) {
  const d = e?.response?.data;
  let m = d?.detail ?? d?.message ?? d?.error ?? e?.message ?? 'request failed';
  if (Array.isArray(m)) {
    m = m.map((x) => (typeof x === 'string' ? x : (x?.msg ? `${(x.loc || []).join('.')}: ${x.msg}` : JSON.stringify(x)))).join('; ');
  } else if (m && typeof m === 'object') {
    m = m.message || JSON.stringify(m);
  }
  const status = e?.response?.status;
  return `${status ? `[${status}] ` : ''}${String(m)}`.slice(0, 500);
}

async function call(method, path, { body, params, responseType, headers, timeout } = {}) {
  const r = await axios({
    method,
    url    : `${API_BASE}${path}`,
    data   : body,
    params,
    responseType,
    timeout: timeout || TIMEOUT_MS,
    headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json', ...(headers || {}) },
  });
  return r;
}

const get   = (p, o) => call('get', p, o);
const post  = (p, body, o) => call('post', p, { ...o, body });
const patch = (p, body, o) => call('patch', p, { ...o, body });

// ─── KB tool authentication ───────────────────────────────────────
// The in-call knowledge-base tool is a PUBLIC HTTP endpoint: anyone can POST to
// it. The tenant therefore cannot come from the request body, and it certainly
// cannot come from anything the language model wrote. Instead the tool carries
// a constant header, minted per company at sync time, that only this server can
// produce. The handler recovers the company id from the token and then
// cross-checks it against the agent id ElevenLabs itself filled in.
function toolSecret() {
  // One dedicated secret, falling back to the webhook secret so a working
  // deployment needs one value, not two. Absent => no token can be minted, and
  // the tool is simply not attached (fail closed, never fail open).
  return (process.env.ELEVENLABS_TOOL_SECRET || process.env.ELEVENLABS_WEBHOOK_SECRET || '').trim();
}

function mintCompanyToken(companyId) {
  const secret = toolSecret();
  if (!secret || !companyId) return null;
  const mac = crypto.createHmac('sha256', secret).update(String(companyId)).digest('base64url');
  return `${companyId}.${mac}`;
}

/** @returns {?string} the company id, or null if the token is absent/forged. */
function verifyCompanyToken(token) {
  const secret = toolSecret();
  const raw = String(token || '').trim();
  if (!secret || !raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const companyId = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(companyId).digest('base64url');
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    return crypto.timingSafeEqual(a, b) ? companyId : null;
  } catch { return null; }
}

// ─── Webhook signature ────────────────────────────────────────────
// Header: `elevenlabs-signature: t=<unix_seconds>,v0=<hex>` where the hex is
// HMAC-SHA256 of `${t}.${rawBody}` under the webhook's signing secret. The
// timestamp is rejected outside a 30-minute window, which is what stops a
// captured webhook being replayed later. Matches the official SDK's
// constructEvent(), reimplemented here so the server needs no extra dependency.
const SIG_TOLERANCE_MS = 30 * 60 * 1000;

// The post-call webhook and the conversation-initiation webhook are separate
// resources with separate secrets AND — verified against the live API on
// 2026-09-19 — separate authentication mechanisms. Deployments that use one
// value for both keep working (ELEVENLABS_WEBHOOK_SECRET is the fallback).
function webhookSecret(kind) {
  const post = (process.env.ELEVENLABS_WEBHOOK_SECRET || '').trim();
  if (kind !== 'init') return post;
  return (process.env.ELEVENLABS_INIT_WEBHOOK_SECRET || '').trim() || post;
}

// ─── Conversation-initiation webhook auth ─────────────────────────
// This webhook is NOT HMAC-signed. Verified against the live API on 2026-09-19:
// its configuration (PATCH /v1/convai/settings →
// conversation_initiation_client_data_webhook) accepts exactly {url,
// request_headers}; `secret` and `auth_method` fields are accepted with HTTP
// 200 and then silently dropped from the stored object. `request_headers` is
// REQUIRED, and its values are a string or a stored-secret reference.
//
// So the only authentication the provider offers here is a constant header of
// our choosing. That is the same shape as the in-call KB tool's
// X-Company-Token: a secret only this server and the provider know, compared in
// constant time. Tenant isolation is unaffected either way — the company is
// still resolved from the dialled number and agent id, never from the body.
const INIT_TOKEN_HEADER = 'x-elevenlabs-init-token';

function verifyInitWebhook(req) {
  const secret = webhookSecret('init');
  if (!secret) {
    // Unset is fatal in production: an unauthenticated init request would be
    // answered with a company name and id. Tolerated in development only, so
    // the flow stays testable before any secret is provisioned.
    return process.env.NODE_ENV !== 'production';
  }
  // If the provider ever does start signing this webhook, a valid signature is
  // accepted too — enabling that later needs no change here.
  if (req.get('elevenlabs-signature') && verifyWebhook(req, 'init')) return true;

  const provided = String(req.get(INIT_TOKEN_HEADER) || '').trim();
  if (!provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function verifyWebhook(req, kind = 'post_call') {
  const secret = webhookSecret(kind);
  if (!secret) {
    // An unset secret is fatal in production — an unauthenticated webhook can
    // write call rows for any tenant. Tolerated in development only.
    return process.env.NODE_ENV !== 'production';
  }
  const header = req.get('elevenlabs-signature') || req.get('ElevenLabs-Signature') || '';
  if (!header) return false;

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const s = part.trim();
    if (s.startsWith('t=')) timestamp = s.slice(2);
    else if (s.startsWith('v0=')) signatures.push(s.slice(3));
  }
  if (!timestamp || !signatures.length) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (ts * 1000 < Date.now() - SIG_TOLERANCE_MS) return false;

  // Sign the RAW bytes. Re-serializing req.body would change key order and
  // whitespace and never match.
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  const expBuf = Buffer.from(expected);
  for (const sig of signatures) {
    try {
      const b = Buffer.from(sig.trim());
      if (b.length === expBuf.length && crypto.timingSafeEqual(b, expBuf)) return true;
    } catch { /* malformed candidate — try the next */ }
  }
  return false;
}

// ─── Ended-reason vocabulary ──────────────────────────────────────
// `calls.ended_reason` is not a display string — it is an INPUT to
// lib/lead-scoring.js (outcome + lead classification), services/campaigns.js
// (retry vs done) and the dashboard's success counter, all of which match
// against a vocabulary established under the previous provider. Rather than
// rewrite three consumers and every historical row, map this provider's
// termination reasons onto that same vocabulary. Anything unrecognised is
// passed through as `provider:<raw>` so it stays visible in the UI and cannot
// accidentally satisfy one of those patterns.
// Matched against a SEPARATOR-NORMALIZED string (see below), so each pattern
// only has to spell one form: `not_in_service` also catches "not in service"
// and "not-in-service". Getting that wrong is silent — an unmatched reason
// falls through to `provider:…` and the campaign report loses a disposition —
// so the normalization is done once, centrally, rather than per pattern.
const REASON_RULES = [
  [/end_call|agent_ended|agent_hangup|tool.*end/i,                     'assistant-ended-call'],
  [/client_disconnect|user_ended|user_hung|caller_hung|customer_ended/i, 'customer-ended-call'],
  [/voicemail|answering_machine/i,                                     'voicemail'],
  [/busy/i,                                                            'busy'],
  [/no_answer|unanswered|ring.*timeout|not_answered/i,                 'customer-did-not-answer'],
  [/invalid|not_in_service|unallocated|does_not_exist/i,               'invalid-number'],
  [/rejected|declined|forbidden|blocked/i,                             'rejected'],
  [/silence|inactivity|no_audio/i,                                     'silence-timed-out'],
  [/max_duration|duration.*(exceed|limit)|time_limit/i,                'max-duration-exceeded'],
  [/transfer|forward/i,                                                'assistant-forwarded-call'],
  [/unreachable|not_reachable|switched_off|powered_off/i,              'switched-off'],
];

function mapEndedReason(raw, { hasTranscript = false } = {}) {
  const s = String(raw || '').trim();
  if (!s) {
    // No reason at all. A call with speech simply finished; one without never
    // connected. Guessing 'no answer' for a call that clearly happened would
    // corrupt the campaign answer-rate.
    return hasTranscript ? 'assistant-ended-call' : null;
  }
  // Collapse spaces and hyphens to underscores so "not in service",
  // "not-in-service" and "not_in_service" all take the same branch.
  const norm = s.replace(/[\s-]+/g, '_');
  // A bare SIP status maps to the `sip-<code>` form the infra-failure detector
  // in lib/lead-scoring.js already recognises.
  const sip = /sip_?(\d{3})/i.exec(norm);
  if (sip) return `sip-${sip[1]}`;
  for (const [re, canonical] of REASON_RULES) if (re.test(norm)) return canonical;
  if (/error|fail/i.test(norm)) return `pipeline-error (${s.slice(0, 80)})`;
  return `provider:${s.slice(0, 80)}`;
}

// ─── Event normalization ──────────────────────────────────────────
// Turns a post-call webhook envelope (or a REST conversation object) into the
// shape in ./provider.js. Note `direction: null` when the provider did not say:
// upsertCall COALESCEs it, so an outbound stub keeps its direction instead of
// being silently relabelled inbound.
function normalizeConversation(data, { eventType = 'post_call_transcription' } = {}) {
  if (!data || typeof data !== 'object') return null;
  const conversationId = data.conversation_id || data.conversationId || null;
  if (!conversationId) return null;

  const meta  = data.metadata || {};
  const phone = meta.phone_call || {};
  const analysis = data.analysis || {};

  const startedAt = toStamp(meta.start_time_unix_secs ?? data.start_time_unix_secs ?? null);
  const durationSec = Number.isFinite(Number(meta.call_duration_secs))
    ? Number(meta.call_duration_secs)
    : null;
  const endedAt = startedAt && durationSec !== null
    ? toStamp(new Date(`${startedAt}Z`).getTime() + durationSec * 1000)
    : null;

  const transcript = flattenTranscript(data.transcript);

  const direction = phone.direction === 'inbound' || phone.direction === 'outbound'
    ? phone.direction
    : null;

  // `external_number` is the customer on both legs; `agent_number` is our 3CX
  // DID. Keeping them in separate fields (rather than one "caller") is what
  // lets inbound resolve a company by the number that was DIALLED.
  const externalNumber = phone.external_number || null;
  const agentNumber    = phone.agent_number || null;

  // This provider does NOT report a fiat amount. Verified against the live API
  // on 2026-09-18: `metadata` carries `cost` (billing CREDITS) plus a `charging`
  // object, and there is no `cost_fiat` in either the conversation detail or the
  // documented post-call webhook payload. Credits are therefore kept as credits;
  // see usdFromCredits for why cost_usd stays null by default.
  const costCredits = Number.isFinite(Number(meta.cost)) ? Number(meta.cost) : null;
  const costUsd = usdFromCredits(costCredits);

  const structuredData = extractStructuredData(analysis.data_collection_results);

  const status = String(data.status || '').toLowerCase();
  const isFinal = eventType === 'post_call_transcription' || status === 'done' || status === 'failed';

  return {
    provider        : NAME,
    providerCallId  : conversationId,
    providerCallRef : phone.call_sid || meta.call_sid || null,
    agentId         : data.agent_id || null,
    companyId       : null,                       // resolved server-side, never parsed
    direction,
    callerNumber    : externalNumber,
    destinationNumber: agentNumber,
    transcript,
    startedAt,
    endedAt,
    durationSec,
    endedReason     : mapEndedReason(meta.termination_reason, { hasTranscript: !!transcript }),
    recordingUrl    : null,
    summary         : analysis.transcript_summary || null,
    structuredData,
    costUsd,
    costCredits,
    isFinal,
    // No public URL: audio is served from an authenticated API endpoint, so
    // there is nothing fetchable to hand a customer's system. The flag carries
    // the "there is audio" signal instead; /api/calls/:id/recording streams the
    // bytes behind our own session auth.
    hasRecording    : !!data.has_audio,
    metadata: {
      status,
      rawTerminationReason: meta.termination_reason || null,
      callSuccessful      : analysis.call_successful || null,
      phoneCallType       : phone.type || null,
      dynamicVariables    : data.conversation_initiation_client_data?.dynamic_variables || null,
    },
  };
}

// The provider bills in CREDITS, and what a credit is worth in dollars depends
// on the workspace's plan — a number the API never discloses. An operator who
// knows their own rate can set ELEVENLABS_USD_PER_CREDIT and get a real
// cost_usd; left unset, the column stays null rather than carrying a guess.
// Never default this to 1: it would make every call look like it cost hundreds
// of dollars, and nothing downstream distinguishes a real figure from a made-up
// one once it is in the column.
function usdFromCredits(credits) {
  if (credits === null || credits === undefined) return null;
  const rate = Number(process.env.ELEVENLABS_USD_PER_CREDIT);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return credits * rate;
}

// `data_collection_results` is a map of identifier -> { value, rationale, ... }.
// `calls.structured_data` has always held a FLAT identifier -> value object
// (that is what lib/lead-scoring.js reads), so unwrap rather than storing the
// provider's envelope and breaking every existing consumer.
function extractStructuredData(results) {
  if (!results || typeof results !== 'object') return null;
  const out = {};
  for (const [key, entry] of Object.entries(results)) {
    const value = (entry && typeof entry === 'object' && 'value' in entry) ? entry.value : entry;
    if (value === null || value === undefined || value === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// Webhook envelope -> normalized event. Returns null for envelopes that carry
// no call state (audio blobs), which the route treats as "ack and ignore".
function normalizeEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const type = payload.type || null;
  const data = payload.data || payload;

  if (type === 'post_call_audio') return null;   // audio is fetched on demand

  if (type === 'call_initiation_failure') {
    // The call never connected, so there is no transcript or metadata to read.
    // Only fields that are unambiguous are set; everything else is left null so
    // the upsert's COALESCE preserves whatever the outbound stub already holds
    // (the customer's number, the start time, the resolved company).
    const conversationId = data.conversation_id || null;
    if (!conversationId) return null;
    const reason = data.reason || data.error || data.failure_reason || 'initiation failed';
    return {
      provider        : NAME,
      providerCallId  : conversationId,
      providerCallRef : data.sip_call_id || null,
      agentId         : data.agent_id || null,
      companyId       : null,
      // An initiation failure can only happen on a call WE placed, so the
      // direction is known even though nothing else about the call is. Saying
      // so explicitly stops the row defaulting to 'inbound' in the race where
      // this event lands before the outbound stub is written.
      direction       : 'outbound',
      callerNumber    : data.to_number || null,
      destinationNumber: null,
      transcript      : null,
      startedAt       : null,
      endedAt         : null,
      durationSec     : 0,
      endedReason     : mapEndedReason(reason, { hasTranscript: false }),
      recordingUrl    : null,
      hasRecording    : false,
      summary         : null,
      structuredData  : null,
      costUsd         : null,
      costCredits     : null,
      isFinal         : true,
      metadata        : { rawTerminationReason: String(reason).slice(0, 200) },
    };
  }

  return normalizeConversation(data, { eventType: type || 'post_call_transcription' });
}

// ─── Company resolution ───────────────────────────────────────────
/**
 * Resolve exactly ONE company from an identifier, or nothing.
 *
 * Uses `.all()` rather than `.get()` on purpose. `.get()` returns whichever row
 * the engine happens to yield first, so if two companies ever claim the same
 * number this would quietly attribute a call to an arbitrary tenant — the worst
 * possible failure for a multi-tenant platform, because it is invisible. A
 * database-level unique index makes that state unreachable going forward, but
 * an index can be absent on an older database (it is installed only once the
 * existing rows are clean), so the code refuses ambiguity independently.
 *
 * @returns {Promise<?string>} the company id, or null when zero OR many match.
 */
async function uniqueCompanyId(statement, value, field, log) {
  if (!value) return null;
  const rows = await statement.all(value);
  if (rows.length === 1) return rows[0].id;
  if (rows.length > 1) {
    (log || logger).error('voice: ambiguous company ownership — refusing to attribute the call', {
      field,
      companies: rows.map((r) => r.id),
      action: 'exactly one company must own this identifier; the call is left unattributed until then',
    });
  }
  return null;
}

// Server-side signals, most specific first. NOTHING a client, a caller or the
// language model can choose is consulted — a `company_id` that arrived in a
// dynamic variable is only ever accepted when it AGREES with one of these.
async function resolveCompanyForEvent(ev, log) {
  if (!ev) return null;

  const byAgent = await uniqueCompanyId(sql.companyByAgentId, ev.agentId, 'elevenlabs_agent_id', log);
  if (byAgent) return byAgent;

  // The 3CX DID. On inbound this is the number that was dialled; on outbound it
  // is the number we called from. Either way it belongs to exactly one company
  // and survives agent recreation.
  const byNumber = await uniqueCompanyId(
    sql.companyByPhoneNumber, ev.destinationNumber, 'phone_number', log,
  );
  if (byNumber) return byNumber;

  const claimed = ev.metadata?.dynamicVariables?.company_id;
  if (claimed) {
    // Cross-check only — and it can never succeed here, because a claim is
    // accepted only when it matches a signal we already resolved, and both of
    // those returned nothing above. Logged so a spoof attempt is visible.
    logger.warn('voice: ignoring unverified company_id from call payload', {
      claimed, agentId: ev.agentId, callId: ev.providerCallId,
    });
  }
  return null;
}

// ─── Agent configuration ──────────────────────────────────────────
// The agent's LLM. Our own catalogue (lib/… resolveAgentModel) speaks OpenAI
// model names, which this provider also accepts; ELEVENLABS_LLM overrides when
// an account needs a different one without a deploy.
function resolveLlm(model) {
  const override = (process.env.ELEVENLABS_LLM || '').trim();
  return override || model || 'gpt-4.1';
}

// The TTS model. Held at turbo v2.5 ON PURPOSE. The expressive line
// (eleven_v3, eleven_v3_conversational, eleven_v4) does list Arabic support,
// but two things make it a change that must be heard before it ships: nobody
// here has listened to a real Saudi call on it, and it drops `tts.speed`,
// which every company's pacing is tuned with. Env-tunable so one deployment
// can try it without a code change — and so switching back is instant.
const TTS_MODEL = (process.env.ELEVENLABS_TTS_MODEL || '').trim() || 'eleven_turbo_v2_5';

// The agent's wall clock. Left unset, `prompt.timezone` reads back null and the
// model has NO idea what "tomorrow at four" refers to — it cannot resolve a
// relative time at all, which is the first thing the appointment-booking flow
// asks of it. Saudi default; env-tunable for a tenant outside the Kingdom.
const AGENT_TIMEZONE = (process.env.ELEVENLABS_AGENT_TIMEZONE || '').trim() || 'Asia/Riyadh';

// Post-call extraction. These identifiers and Arabic descriptions are carried
// over VERBATIM from the previous provider's analysis schema, because
// lib/lead-scoring.js and the campaign report read them by name. Renaming one
// would silently blank a column in the report for every future call.
const DATA_COLLECTION = {
  interest_level       : { type: 'string',  description: 'مستوى اهتمام العميل بالعرض. أعد واحدة فقط من: مهتم جدا، مهتم، متردد، غير مهتم' },
  property_type        : { type: 'string',  description: 'نوع العقار المطلوب (شقة، فيلا، أرض، مكتب...) إن ذُكر' },
  budget               : { type: 'string',  description: 'الميزانية المذكورة بالريال إن ذُكرت' },
  preferred_area       : { type: 'string',  description: 'الحي أو المنطقة المفضلة إن ذُكرت' },
  callback_requested   : { type: 'boolean', description: 'هل طلب العميل التواصل معه لاحقاً' },
  appointment_requested: { type: 'boolean', description: 'هل طلب العميل موعد معاينة أو زيارة' },
  notes                : { type: 'string',  description: 'ملاحظة مهمة واحدة للمبيعات إن وجدت' },
  customer_intent      : { type: 'string',  description: 'ماذا يريد العميل بالضبط في جملة واحدة قصيرة' },
  next_action          : { type: 'string',  description: 'الإجراء التالي المقترح لفريق المبيعات في جملة واحدة' },
};

// Language code for ASR/TTS. Our companies store 'ar-SA'; this provider wants
// the bare ISO code.
const langCode = (v) => String(v || 'ar').split('-')[0].toLowerCase() || 'ar';

/**
 * Build the agent payload. Pure — no network — so it can be unit-tested and
 * diffed without an API key.
 */
function buildAgentConfig({
  name, prompt, firstMessage, language,
  model, temperature, maxTokens,
  voiceId, stability, similarityBoost, voiceSpeed,
  toolIds = [], transferNumber = null,
  maxDurationSeconds = 600, idleTimeoutSeconds = 15, silenceTimeoutSeconds = 30,
}) {
  // System tools are declared inline; the knowledge-base tool is a workspace
  // tool referenced by id (that is the only form the tools API supports).
  const tools = [
    { type: 'system', name: 'end_call', description: '', params: { system_tool_type: 'end_call' } },
  ];
  if (transferNumber) {
    tools.push({
      type: 'system',
      name: 'transfer_to_number',
      description: 'تحويل المكالمة إلى موظف بشري عند الحاجة.',
      params: {
        system_tool_type: 'transfer_to_number',
        transfers: [{
          transfer_destination: { type: 'phone', phone_number: transferNumber },
          condition: 'عندما يطلب العميل التحدث مع موظف بشري أو عندما لا تستطيع مساعدته.',
        }],
      },
    });
  }

  return {
    name,
    conversation_config: {
      agent: {
        first_message: firstMessage,
        language     : langCode(language),
        // A caller's "ألو" must not cut the greeting off half-way. The greeting
        // is one short sentence, so holding it to the end costs nothing and
        // stops the call opening on a truncated company name.
        disable_first_message_interruptions: true,
        prompt: {
          prompt     : prompt,
          llm        : resolveLlm(model),
          temperature,
          max_tokens : maxTokens,
          timezone   : AGENT_TIMEZONE,
          tools,
          ...(toolIds.length ? { tool_ids: toolIds } : {}),
        },
      },
      tts: {
        model_id        : TTS_MODEL,
        voice_id        : voiceId,
        stability,
        similarity_boost: similarityBoost,
        speed           : voiceSpeed,
      },
      asr: { quality: 'high' },
      turn: {
        // The previous provider's idle prompt after 15s of silence has no
        // equivalent here; turn_timeout is the closest knob. The hard stop
        // after 30s of total silence is preserved exactly.
        turn_timeout            : idleTimeoutSeconds,
        silence_end_call_timeout: silenceTimeoutSeconds,
      },
      conversation: { max_duration_seconds: maxDurationSeconds },
    },
    platform_settings: {
      // Per-call overrides do NOTHING unless the field is enabled here first.
      // Outbound campaigns depend on first_message (the personalised greeting
      // with {{customer_name}}), so omitting this would break them silently.
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts  : { voice_id: true, stability: true, speed: true, similarity_boost: true },
        },
        // WITHOUT THIS FLAG THE INITIATION WEBHOOK IS NEVER CALLED. It defaults
        // to false, and a false value fails silently: inbound calls connect and
        // sound fine, but the agent gets no company_id, no company_name and no
        // caller_number, so every inbound call is depersonalised. Verified
        // against the live API on 2026-09-18 — an agent created without it reads
        // back `false`, and with it reads back `true`.
        enable_conversation_initiation_client_data_from_webhook: true,
      },
      data_collection: DATA_COLLECTION,
      // Prompt-injection screening. This agent is reachable by anyone who can
      // dial the company's published number, and it carries tools that read
      // tenant data, so a caller reciting instructions at it is a real attack
      // surface rather than a theoretical one. Off by default on the provider
      // side. The other guardrail families (content moderation, synthetic-voice
      // detection) are left at their defaults deliberately: they need
      // per-tenant thresholds nobody has set, and a false positive there drops
      // a real customer's call.
      guardrails: {
        version: '1',
        prompt_injection: { is_enabled: true },
      },
    },
  };
}

// ─── Workspace tools ──────────────────────────────────────────────
/**
 * Build a webhook tool from a registry feature declaration.
 *
 * Generic so a capability is added by declaring it, not by writing another
 * builder. The shape is exactly the one buildKbToolConfig has always produced —
 * a test asserts the two are deep-equal for knowledge_base, because that config
 * is live on published agents and drifting from it would silently change what
 * the model can send.
 *
 * Returns null with no tool secret configured: no token can be minted, so the
 * endpoint could not authenticate the call. Fail closed, never fail open.
 */
function buildFeatureToolConfig({ feature, companyId, publicBaseUrl }) {
  const token = mintCompanyToken(companyId);
  if (!token || !feature?.endpoint) return null;
  return {
    type       : 'webhook',
    name       : feature.toolName,
    description: feature.toolDescriptionAr || feature.descriptionAr || '',
    response_timeout_secs: feature.responseTimeoutSecs || 10,
    api_schema : {
      url    : `${publicBaseUrl}/webhook/elevenlabs/tools/${feature.endpoint}`,
      method : 'POST',
      // The tenant lives in this header, minted by us and stored by the
      // provider. The model cannot read, reach or alter it.
      request_headers: { 'X-Company-Token': token },
      request_body_schema: {
        type: 'object',
        properties: {
          ...(feature.bodyProperties || {}),
          // Filled by the provider, not the model. The handler checks agent_id
          // maps to the same company as the header — defence in depth.
          agent_id: {
            type: 'string',
            description: 'internal',
            constant_value: '{{system__agent_id}}',
          },
          conversation_id: {
            type: 'string',
            description: 'internal',
            constant_value: '{{system__conversation_id}}',
          },
        },
        required: feature.bodyRequired || [],
      },
    },
  };
}

// The original knowledge-base builder. Retained as the reference implementation
// that buildFeatureToolConfig is tested against, and still used by syncAgent's
// legacy path.
function buildKbToolConfig({ companyId, publicBaseUrl }) {
  const token = mintCompanyToken(companyId);
  if (!token) return null;                        // no secret => no tool, fail closed
  return {
    type       : 'webhook',
    name       : 'search_knowledge_base',
    description: 'البحث في قاعدة معرفة الشركة عن معلومة محددة (أسعار، مشاريع، مواصفات، عروض) عندما لا تكون المعلومة متوفرة في تعليماتك. استخدمها قبل أن تقول إن المعلومة غير متوفرة.',
    response_timeout_secs: 10,
    api_schema : {
      url    : `${publicBaseUrl}/webhook/elevenlabs/tools/kb`,
      method : 'POST',
      // The tenant lives in this header, minted by us and stored by the
      // provider. The model cannot read, reach or alter it.
      request_headers: { 'X-Company-Token': token },
      request_body_schema: {
        type: 'object',
        properties: {
          // The ONLY model-authored field.
          query: { type: 'string', description: 'نص السؤال أو الكلمات المفتاحية للبحث' },
          // Filled by the provider, not the model. The handler checks it maps
          // to the same company as the header — defence in depth.
          agent_id: {
            type: 'string',
            description: 'internal',
            constant_value: '{{system__agent_id}}',
          },
          conversation_id: {
            type: 'string',
            description: 'internal',
            constant_value: '{{system__conversation_id}}',
          },
        },
        required: ['query'],
      },
    },
  };
}

/**
 * Create-or-update ONE workspace tool. Capability-agnostic: the caller supplies
 * the built config and whatever id it already has for that capability.
 */
async function upsertTool({ cfg, existingToolId, label, log }) {
  if (!cfg) return null;
  if (existingToolId) {
    try {
      await patch(`/v1/convai/tools/${encodeURIComponent(existingToolId)}`, { tool_config: cfg });
      return existingToolId;
    } catch (e) {
      // 404 => deleted in the dashboard. Anything else is a real failure and
      // must not be papered over by silently creating a duplicate tool.
      if (e?.response?.status !== 404) throw e;
      log?.warn?.('voice: stored tool is gone, recreating', { label, toolId: existingToolId });
    }
  }
  const r = await post('/v1/convai/tools', { tool_config: cfg });
  return r.data?.id || r.data?.tool_id || null;
}

/** Remove a tool the company no longer has the capability for. */
async function deleteTool(toolId, log) {
  if (!toolId) return false;
  try {
    await call('delete', `/v1/convai/tools/${encodeURIComponent(toolId)}`);
    return true;
  } catch (e) {
    // Already gone is success: the goal is "this tool is not attached", and a
    // 404 means somebody got there first.
    if (e?.response?.status === 404) return true;
    log?.warn?.('voice: could not delete tool', { toolId, err: errText(e) });
    return false;
  }
}

async function upsertKbTool({ companyId, publicBaseUrl, existingToolId, log }) {
  const cfg = buildKbToolConfig({ companyId, publicBaseUrl });
  if (!cfg) {
    log?.warn?.('voice: KB tool skipped — set ELEVENLABS_TOOL_SECRET (or ELEVENLABS_WEBHOOK_SECRET)', { companyId });
    return null;
  }
  return upsertTool({ cfg, existingToolId, label: 'knowledge_base', log });
}

// ─── Agent create-or-update ───────────────────────────────────────
// Verifies a stored id still exists (clears on 404), recovers by name, then
// PATCH/POST. Same recovery ladder the previous provider's sync used — it
// exists because agents get deleted from the dashboard and a blind PATCH then
// fails forever.
async function upsertAgent(cfg, existingId, log) {
  let id = existingId;
  if (id) {
    try {
      await get(`/v1/convai/agents/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        log?.warn?.('voice: stored agent gone, recreating', { agentId: id });
        id = null;
      } else throw e;
    }
  }
  if (!id) {
    try {
      const r = await get('/v1/convai/agents', { params: { page_size: 100 } });
      const list = r.data?.agents || r.data || [];
      id = (Array.isArray(list) ? list : []).find((a) => a?.name === cfg.name)?.agent_id || null;
    } catch (e) {
      log?.warn?.('voice: agent lookup by name failed, will create', { err: errText(e) });
    }
  }
  if (id) {
    await patch(`/v1/convai/agents/${encodeURIComponent(id)}`, cfg);
    return id;
  }
  const r = await post('/v1/convai/agents/create', cfg);
  return r.data?.agent_id || r.data?.id || null;
}

// The transfer tool's `transfers` shape is the least-documented part of this
// payload. Rather than let one uncertain field block a sync — which would take
// the company's phone line down — retry once without it and say so loudly.
async function upsertAgentTolerant(cfg, existingId, log) {
  try {
    return await upsertAgent(cfg, existingId, log);
  } catch (e) {
    const hasTransfer = (cfg.conversation_config?.agent?.prompt?.tools || [])
      .some((t) => t?.name === 'transfer_to_number');
    if (!hasTransfer || e?.response?.status !== 422) throw e;
    log?.error?.('voice: agent rejected the transfer_to_number tool — syncing WITHOUT human transfer', {
      err: errText(e),
    });
    const stripped = JSON.parse(JSON.stringify(cfg));
    stripped.conversation_config.agent.prompt.tools =
      stripped.conversation_config.agent.prompt.tools.filter((t) => t?.name !== 'transfer_to_number');
    return upsertAgent(stripped, existingId, log);
  }
}

/**
 * Rebuild this company's agent(s) from its active scenario.
 * `opts.prompt` / `opts.promptInbound` are already composed by the caller
 * (server.js composeSystemPrompt) so the voice channel and every test channel
 * run on byte-identical text.
 */
async function syncAgent(company, opts) {
  const {
    prompt, promptInbound, firstMessage, firstMessageInbound,
    model, temperature, maxTokens,
    voiceId, stability, similarityBoost, voiceSpeed,
    transferNumber, wantsKbTool, webhookTools, publicBaseUrl, log,
    hooks = {},
  } = opts;

  // `webhookTools` is the capability plan: one entry per ENABLED capability
  // that needs a tool of ours, each carrying the id already registered for it.
  // Capabilities the company does not have simply are not in this list, so a
  // disabled one cannot be attached by accident.
  //
  // `wantsKbTool` remains supported for callers that have not moved to the
  // plan yet; it is translated into the same single-entry list.
  let plan = Array.isArray(webhookTools) ? webhookTools : null;
  if (!plan) {
    plan = (wantsKbTool && publicBaseUrl)
      ? [{ featureKey: 'knowledge_base', cfg: buildKbToolConfig({ companyId: company.id, publicBaseUrl }) }]
      : [];
  }

  const toolIds = [];
  let toolId = null;                       // kept for the legacy return shape
  for (const entry of plan) {
    if (!entry?.cfg) continue;             // no secret => no token => no tool
    const id = await upsertTool({
      cfg: entry.cfg, existingToolId: entry.existingToolId || null,
      label: entry.featureKey, log,
    });
    if (!id) continue;
    toolIds.push(id);
    if (entry.featureKey === 'knowledge_base') toolId = id;
    // Hand the id back the INSTANT the tool exists, before anything else can
    // throw. Persisting only after this whole function returned meant a failure
    // in the agent PATCH below discarded a tool that had really been created —
    // and the next publish, seeing no stored id, created a second one.
    await hooks.onToolSynced?.(id, entry.featureKey);
  }

  const base = {
    // Deterministic, tenant-scoped name. It is also the recovery key when a
    // stored agent id goes missing, so it must stay stable per company.
    name: `smart-assistant:${company.id}`,
    prompt, firstMessage, language: company.language,
    model, temperature, maxTokens,
    voiceId, stability, similarityBoost, voiceSpeed,
    toolIds, transferNumber,
  };

  const agentId = await upsertAgentTolerant(buildAgentConfig(base), company.agentId, log);
  await hooks.onAgentSynced?.(agentId);

  // Optional second agent, only when the scenario defines separate inbound
  // instructions. Companies without one keep a single agent, exactly as before.
  let agentIdInbound = null;
  if (promptInbound && promptInbound.trim()) {
    agentIdInbound = await upsertAgentTolerant(
      buildAgentConfig({
        ...base,
        name: `smart-assistant:${company.id}:inbound`,
        prompt: promptInbound,
        firstMessage: firstMessageInbound || firstMessage,
      }),
      company.agentIdInbound,
      log,
    );
    await hooks.onInboundAgentSynced?.(agentIdInbound);
  }

  return { agentId, agentIdInbound, toolId };
}

// ─── Phone numbers ────────────────────────────────────────────────
/**
 * Import an existing 3CX DID as a SIP-trunk number. No number is ever
 * purchased from the provider: `phone_number` is the company's own DID and
 * `outbound_trunk_config.address` points back at the customer's PBX.
 */
/**
 * The SIP trunk half of the import/update payload. Pure, so the exact field
 * names can be asserted in a test without a key or a network.
 *
 * Every name and enum below is verified against the live API (2026-09-18): the
 * sip_trunk variant of POST /v1/convai/phone-numbers is
 * CreateSIPTrunkPhoneNumberRequestV2, `outbound_trunk_config.address` is
 * required, `credentials.username` is required whenever credentials are given,
 * `transport` is one of auto|udp|tcp|tls, and `media_encryption` is one of
 * disabled|allowed|required.
 */
function buildTrunkConfig(sip = {}) {
  const encryption = sip.mediaEncryption || 'allowed';
  const credentials = sip.username
    ? { credentials: { username: sip.username, password: sip.password } }
    : {};
  return {
    inbound_trunk_config: {
      // Digest credentials are preferred over an IP allowlist: a PBX on a
      // dynamic address silently stops working the day its IP changes.
      ...credentials,
      ...(sip.allowedAddresses?.length ? { allowed_addresses: sip.allowedAddresses } : {}),
      media_encryption: encryption,
    },
    outbound_trunk_config: {
      address        : sip.address,               // hostname or IP — never a sip: URI
      transport      : sip.transport || 'tls',
      media_encryption: encryption,
      ...credentials,
    },
  };
}

async function importPhoneNumber(company, sip = {}) {
  const phoneNumber = String(sip.phoneNumber || company.phoneNumber || '').trim();
  if (!isE164(phoneNumber)) {
    throw new Error(`company "${company.id}" has no valid E.164 phone number to import`);
  }
  if (!sip.address) throw new Error('SIP outbound address (the 3CX host) is required');

  const trunk = buildTrunkConfig(sip);
  const agentField = company.agentId ? { agent_id: company.agentId } : {};

  // Idempotency. Importing a number the workspace already holds fails with
  // HTTP 409 `resource_already_exists`, so a plain re-run of provisioning would
  // abort halfway instead of converging — and an operator retrying after a
  // partial failure is exactly when that hurts. Look first, and UPDATE the
  // existing record when the number is already ours.
  const existing = await findPhoneNumber(phoneNumber);
  if (existing?.phone_number_id) {
    await patch(`/v1/convai/phone-numbers/${encodeURIComponent(existing.phone_number_id)}`,
      { ...trunk, ...agentField });
    return { phoneNumberId: existing.phone_number_id, phoneNumber, reused: true };
  }

  try {
    const r = await post('/v1/convai/phone-numbers', {
      phone_number: phoneNumber,
      label       : `smart-assistant:${company.id}`,
      provider    : 'sip_trunk',
      ...agentField,
      ...trunk,
    });
    const phoneNumberId = r.data?.phone_number_id || null;
    if (!phoneNumberId) throw new Error('import succeeded but returned no phone_number_id');
    return { phoneNumberId, phoneNumber, reused: false };
  } catch (e) {
    if (e?.response?.status !== 409) throw e;
    // Either a race with a concurrent run, or the number belongs to a DIFFERENT
    // ElevenLabs workspace. A number can only be registered once platform-wide,
    // and the list endpoint only shows our own, so we cannot tell the two apart
    // except by looking again.
    const raced = await findPhoneNumber(phoneNumber);
    if (raced?.phone_number_id) {
      await patch(`/v1/convai/phone-numbers/${encodeURIComponent(raced.phone_number_id)}`,
        { ...trunk, ...agentField });
      return { phoneNumberId: raced.phone_number_id, phoneNumber, reused: true };
    }
    const err = new Error(
      `${phoneNumber} is already registered to a DIFFERENT ElevenLabs workspace. `
      + 'A number can only be imported once across the whole platform — release it there first, '
      + 'or contact ElevenLabs support.');
    err.code = 'PHONE_NUMBER_TAKEN';
    throw err;
  }
}

// ─── Verification reads ───────────────────────────────────────────
/**
 * The agent exactly as the provider stored it — not as we sent it. The two can
 * differ silently: `enable_conversation_initiation_client_data_from_webhook`
 * is accepted and defaulted to false, which depersonalises every inbound call
 * while the publish reports success. Returns null on 404 so a caller can tell
 * "gone" from "request failed".
 */
async function getAgent(agentId) {
  if (!agentId) return null;
  try {
    const r = await get(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
    return r.data || null;
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/** Workspace-level webhook configuration, for verifying publish prerequisites. */
async function getWorkspaceSettings() {
  const r = await get('/v1/convai/settings');
  return r.data || null;
}

/**
 * The numbers THIS workspace owns. The API returns a bare array today; the
 * envelope form is tolerated so a future change does not silently yield "no
 * numbers" and make import look necessary when it is not.
 */
async function listPhoneNumbers() {
  const r = await get('/v1/convai/phone-numbers');
  const d = r.data;
  return Array.isArray(d) ? d : (Array.isArray(d?.phone_numbers) ? d.phone_numbers : []);
}

async function findPhoneNumber(phoneNumber) {
  const wanted = String(phoneNumber || '').trim();
  if (!wanted) return null;
  const all = await listPhoneNumbers();
  return all.find((p) => String(p?.phone_number || '').trim() === wanted) || null;
}

/** Point the company's imported number at the agent that should answer it. */
async function bindPhoneNumber(company) {
  const phoneNumberId = company.phoneNumberId;
  if (!phoneNumberId) {
    const err = new Error('company has no ElevenLabs phone number id — import the 3CX number first');
    err.code = 'NO_PHONE_NUMBER_ID';
    throw err;
  }
  // Inbound calls go to the inbound agent when the scenario defines one,
  // otherwise to the single agent.
  const agentId = company.agentIdInbound || company.agentId;
  if (!agentId) {
    const err = new Error('company has no agent — publish it first');
    err.code = 'NOT_PUBLISHED';
    throw err;
  }
  await patch(`/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, { agent_id: agentId });
  return { phoneNumberId, agentId, phoneNumber: company.phoneNumber };
}

// ─── Outbound ─────────────────────────────────────────────────────
/**
 * Place a call through the company's OWN imported number, so the customer sees
 * the company's real DID and the leg routes back through their 3CX trunk.
 */
async function startOutboundCall({ company, toNumber, variables = {}, firstMessage = null }) {
  if (!company.agentId) {
    const err = new Error('company has no agent'); err.code = 'NOT_PUBLISHED'; throw err;
  }
  if (!company.phoneNumberId) {
    const err = new Error('company has no outbound number'); err.code = 'NO_PHONE_NUMBER_ID'; throw err;
  }
  if (!isE164(toNumber)) {
    const err = new Error('invalid destination number'); err.code = 'BAD_NUMBER'; throw err;
  }

  const clientData = {};
  // company_id travels as a dynamic variable for observability only. The
  // webhook path never trusts it — see resolveCompanyForEvent.
  const dynamic = { ...variables, company_id: company.id };
  clientData.dynamic_variables = dynamic;
  if (firstMessage) {
    // Requires platform_settings.overrides.…first_message = true, which
    // buildAgentConfig sets on every sync.
    clientData.conversation_config_override = { agent: { first_message: firstMessage } };
  }

  const r = await post('/v1/convai/sip-trunk/outbound-call', {
    agent_id             : company.agentId,
    agent_phone_number_id: company.phoneNumberId,
    to_number            : toNumber,
    conversation_initiation_client_data: clientData,
  });

  const d = r.data || {};
  if (d.success === false) {
    throw new Error(String(d.message || 'provider refused the call').slice(0, 300));
  }
  if (!d.conversation_id) {
    throw new Error(String(d.message || 'provider returned no conversation id').slice(0, 300));
  }
  return { callId: d.conversation_id, callRef: d.sip_call_id || null, status: 'queued' };
}

// ─── Read-back ────────────────────────────────────────────────────
async function fetchCall(providerCallId) {
  if (!providerCallId) return null;
  try {
    const r = await get(`/v1/convai/conversations/${encodeURIComponent(providerCallId)}`);
    return normalizeConversation(r.data, { eventType: 'rest' });
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

async function listRecentCalls(limit = 50) {
  const pageSize = Math.min(100, Math.max(1, limit));
  const r = await get('/v1/convai/conversations', { params: { page_size: pageSize } });
  const rows = r.data?.conversations || [];
  const out = [];
  // The list response is a summary; the transcript and analysis only come from
  // the per-conversation GET. Sequential on purpose — this is an occasional
  // operator-triggered backfill, not a hot path, and parallel fan-out here
  // would be the thing that trips the API rate limit.
  for (const row of rows.slice(0, limit)) {
    const id = row.conversation_id;
    if (!id) continue;
    try {
      const full = await fetchCall(id);
      if (full) out.push(full);
    } catch (e) {
      logger.warn('voice: backfill skipped one conversation', { id, err: errText(e) });
    }
  }
  return out;
}

/**
 * Stream a recording. Unlike the previous provider (which handed out expiring
 * presigned storage URLs that broke once they aged out), audio here is fetched
 * straight from the API with our key and piped through our own auth — so a
 * stored URL can never go stale and the storage location is never exposed.
 */
async function fetchRecording(providerCallId, { range } = {}) {
  if (!providerCallId) return null;
  try {
    const r = await call('get', `/v1/convai/conversations/${encodeURIComponent(providerCallId)}/audio`, {
      responseType: 'stream',
      headers     : range ? { Range: range } : {},
      timeout     : 30_000,
    });
    return { status: r.status, stream: r.data, headers: r.headers };
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

module.exports = {
  name: NAME,
  // contract
  syncAgent, bindPhoneNumber, importPhoneNumber, startOutboundCall,
  fetchCall, fetchRecording, listRecentCalls, verifyWebhook, normalizeEvent,
  // provider-specific extras used by the webhook route and the provision script
  resolveCompanyForEvent, uniqueCompanyId, mintCompanyToken, verifyCompanyToken,
  listPhoneNumbers, findPhoneNumber, verifyInitWebhook, INIT_TOKEN_HEADER,
  getAgent, getWorkspaceSettings,
  // exported for tests
  buildAgentConfig, buildKbToolConfig, buildFeatureToolConfig, buildTrunkConfig,
  upsertTool, deleteTool, mapEndedReason,
  normalizeConversation, extractStructuredData, errText, DATA_COLLECTION,
  usdFromCredits, webhookSecret,
};
