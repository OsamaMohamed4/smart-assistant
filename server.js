require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const OpenAI  = require('openai');
const helmet  = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const multer = require('multer');
const { db, sql, get: dataGet, all: dataAll, run: dataRun, withTransaction, initDb, healthCheck, close: dbClose, isPg } = require('./db');
const { loadCompany, listCompaniesFull, invalidateCache, buildSystemPromptWithRAG, fillGlobals } = require('./companies');
const { summarize, chatToTranscript } = require('./summarize');
const { ingestDocument, retrieve, repairMojibake, invalidateChunkCache } = require('./lib/rag');
const { END_CALL_TOOL_RULE } = require('./lib/master-prompt');
const { renderFactsBlock, businessProfileSchema, parseBusinessProfile } = require('./lib/business-profile');
const { lintScenario } = require('./lib/scenario-lint');
const { TEMPLATES: SCENARIO_TEMPLATES } = require('./lib/scenario-templates');
const { validate } = require('./lib/validate');
const schemas = require('./lib/schemas');
const metrics = require('./lib/metrics');
const { enforceSecretsAtBoot } = require('./lib/secrets');
const { shutdown: queueShutdown } = require('./lib/queue');
const { runWithContext } = require('./lib/tenant-context');
const { isSafeUrl } = require('./lib/ssrf');
const { encryptField, decryptField, decryptRow, decryptRows, CALL_PII_FIELDS } = require('./lib/pii');
const { qualifyCall, LEAD } = require('./lib/lead-scoring');
const authRoutes = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const { router: webhookRoutes, getRecentWebhookAttempts } = require('./routes/webhook');
const campaignsRoutes = require('./routes/campaigns');
const evalsRoutes = require('./routes/evals');
const { startDrainTimer, backfillRecentCalls, refreshCall, recordingLinkFor } = require('./services/call-events');
const voice = require('./services/voice');
const { publishCompany } = require('./services/publish/pipeline');
const { describeFeatures, setFeature } = require('./services/features/store');
const { startCampaignWorker, getWorkerHealth: getCampaignWorkerHealth } = require('./services/campaigns');
const { startRetentionWorker } = require('./services/retention');
const { dailyCap, checkAndBumpUsage } = require('./services/usage');
const { audit } = require('./lib/audit');
const { requireAuth, requireCompanyAccess, requireCompanyAdmin, canChatWithCompany, startSessionCleanup } = require('./lib/auth');
const { logger } = require('./lib/logger');
const { initMonitoring, captureError } = require('./lib/monitoring');
const { startBackupScheduler, runBackup, getBackupStatus } = require('./lib/backup');

initMonitoring(logger);
startBackupScheduler(logger);

// Allow only the document types our RAG pipeline can actually parse.
// pdf-parse, mammoth, and plain text are the supported readers.
const ALLOWED_DOC_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/markdown',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOC_MIMES.has(file.mimetype)) {
      return cb(new Error('Unsupported file type. Allowed: PDF, DOCX, TXT, MD.'));
    }
    cb(null, true);
  },
});

// Separate multer instance for audio (Playground mic upload). Capped lower
// than docs (4MB ≈ 60s of opus webm) and limited to webm/ogg/wav/mp4 audio.
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/^audio\/(webm|ogg|wav|mpeg|mp4|x-m4a)/.test(file.mimetype)) {
      return cb(new Error('Unsupported audio type'));
    }
    cb(null, true);
  },
});

// External-API timeouts (ms). Default policy: never let a hanging upstream
// pin a request indefinitely. OpenAI is the most variable.
const OPENAI_TIMEOUT_MS = 25_000;

const openai = new OpenAI({
  apiKey : process.env.OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT_MS,
  maxRetries: 1,
});
const app = express();

// Trust proxy hops in front of Node. Misconfiguration here lets attackers
// spoof X-Forwarded-For and bypass per-IP rate limits + lockout. Set to:
//   0  — Node is exposed directly (no proxy). Safest bare default.
//   1  — exactly one trusted proxy (e.g. Railway edge, nginx, Cloudflare).
//   2+ — chained proxies (e.g. Cloudflare → nginx).
// On Railway there is ALWAYS one proxy in front of us; with trust=0 every
// request reports the proxy's IP, so all users share one rate-limit bucket
// (one abuser exhausts login attempts for everyone). Auto-detect Railway
// and default to 1 there; the TRUST_PROXY env var still overrides.
const ON_RAILWAY = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_STATIC_URL);

// Public base URL of THIS server (no trailing slash). Needed when we hand the
// voice provider a callback URL (the in-call KB search tool). Railway exposes
// the public domain as RAILWAY_PUBLIC_DOMAIN; PUBLIC_BASE_URL env overrides.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/+$/, '');
const TRUST_PROXY = Number.isFinite(Number(process.env.TRUST_PROXY))
  ? Number(process.env.TRUST_PROXY)
  : (ON_RAILWAY ? 1 : 0);
app.set('trust proxy', TRUST_PROXY);

// Strict CSP for the SPA. `unsafe-inline` on style is required by Tailwind's
// runtime styles + lucide-react inline SVG styling. All script must be served
// from same origin: no inline JS, no eval, no third-party script host.
//
// The browser talks to NO voice provider. Calls are placed server-side over
// SIP and answered on a real phone, so the browser voice SDK this app used to
// load — which required third-party script/media/websocket origins and
// 'unsafe-eval' to run a remotely-fetched WebRTC bundle — has no successor.
// Those allowances are deleted rather than retargeted; dropping 'unsafe-eval'
// is a real tightening, not a rename. The only remaining cross-origin connect
// target is Sentry error reporting.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      scriptSrcAttr:  ["'none'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc:         ["'self'", "data:", "blob:"],
      fontSrc:        ["'self'", "data:", 'https://fonts.gstatic.com'],
      connectSrc:     ["'self'", 'https://*.ingest.sentry.io'],
      // Recordings stream from our own /api/calls/:id/recording proxy, so the
      // <audio> element only ever loads same-origin bytes.
      mediaSrc:       ["'self'", "blob:"],
      workerSrc:      ["'self'", 'blob:'],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  // HSTS only meaningful behind HTTPS — auto on by default in helmet; fine.
}));
app.use(cookieParser());

// Raw body capture for provider webhook HMAC verification. The signature is
// over the exact bytes sent, so a re-serialized req.body would never match.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// Attach a per-request id + child logger. Echoed back as `X-Request-Id` so
// clients can correlate. Honors an incoming X-Request-Id if the upstream
// proxy set one.
app.use(async (req, res, next) => {
  const incoming = String(req.get('x-request-id') || '').slice(0, 64);
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
    ? incoming
    : crypto.randomBytes(8).toString('hex');
  req.id  = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('X-Request-Id', id);
  next();
});

// Prometheus: time every request + emit a structured access-log line (Task #6).
app.use(metrics.httpMetricsMiddleware);

// RLS tenant context (Task #2). Defaults to the system bypass so unauthenticated,
// webhook and worker paths behave exactly as they do today. requireAuth narrows
// it to the caller's company for client sessions; Postgres then enforces the
// isolation even if a query forgets its company_id filter.
app.use((req, _res, next) => {
  req.dbContext = { bypass: true, companyId: null };
  runWithContext(req.dbContext, next);
});

// Apply CSRF gate globally (still skips GETs and /webhook/*).
app.use(requireXhrHeader);

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : 30,
  standardHeaders: true,
  legacyHeaders  : false,
  message : { error: 'too many requests' },
});

// Server-to-server Agent API limiter. Keyed per credential (not per IP) so
// one busy tenant can't starve the others behind a shared BSP egress IP.
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : Number(process.env.AGENT_RATE_PER_MIN) || 120,
  standardHeaders: true,
  legacyHeaders  : false,
  keyGenerator: (req) => {
    const cred = req.get('authorization') || req.get('x-api-key') || 'anon';
    return 'k:' + crypto.createHash('sha256').update(String(cred)).digest('hex').slice(0, 16);
  },
  message : { success: false, error: 'too many requests' },
});

// Daily usage caps live in services/usage.js (dailyCap, checkAndBumpUsage).

// CSRF defense for cookie-authenticated endpoints: the SPA always sends
// `X-Requested-With: XMLHttpRequest`, which a cross-origin form-style attacker
// cannot set without triggering a CORS preflight. Pairs with SameSite=Lax.
// Skip for safe methods and for provider webhooks (server-to-server, each with
// its own authentication — HMAC signature or a minted per-company token).
function requireXhrHeader(req, res, next) {
  const m = req.method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (req.path.startsWith('/webhook/')) return next();
  // Public API endpoints (server-to-server). They authenticate via
  // Bearer API key so the CSRF cookie+SameSite shield doesn't apply.
  if (req.path.startsWith('/api/v1/')) return next();
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'CSRF check failed' });
  }
  next();
}

startSessionCleanup();

// Customer page: SPA handles routing inside the same React build.
app.get('/c/:companyId', async (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Auth routes mount BEFORE the global /api auth gate.
app.use('/api/auth', authRoutes);

// Public-safe view of a company. Used by the client login page to render the
// company branding before the user is authenticated, and by the post-login
// customer experience to render the phone-call panel. `phoneNumber` is
// included because it's marketing-grade info already advertised by the
// business; voiceId, system prompt, and KB stay hidden.
app.get('/api/public/companies/:id', async (req, res) => {
  if (!COMPANY_ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({
    id         : c.id,
    name       : c.name,
    language   : c.language,
    hasKB      : c.hasKB,
    phoneNumber: c.phoneNumber,
  });
});

// ─── Public Agent HTTP API (/api/v1/agent/chat) ──────────────────
// External integrations (WhatsApp BSPs, custom channels) POST a customer
// message here and get the AI agent's text reply, synchronously.
//
// Provider note: the voice provider has no synchronous text endpoint — its
// text channel is asynchronous (accept now, reply by webhook later), which
// would break this contract for every existing caller. So text runs on the
// SAME scenario prompt and the SAME RAG retrieval as voice, executed locally:
// buildSystemPromptWithRAG() is the single source of truth that the voice sync
// also composes from, and resolveAgentModel() picks the identical model. What
// a caller tests here is still what the scenario says.
//
// Continuity: the conversation is rebuilt from the `chats` table, keyed by a
// deterministic per-customer session id, so a customer messaging over days
// resumes where they left off with no provider-side thread to expire.
// Resolve the caller's API key to a company scope.
//  1. Per-company key (api_keys table, sha256 lookup) — the correct path.
//     The key itself IS the tenant scope; a body company_id that disagrees
//     is rejected so a leaked key can never reach another tenant.
//  2. Legacy global AGENT_API_KEY — kept for compatibility during
//     migration; logs a deprecation warning. Scope is whatever company_id
//     the body claims (the historical, unsafe behavior).
async function resolveAgentApiAuth(req) {
  const authHeader = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  const provided = (m?.[1] || req.get('x-api-key') || '').trim();
  if (!provided) return { error: 'missing api key', status: 401 };

  const hash = crypto.createHash('sha256').update(provided).digest('hex');
  const keyRow = await sql.getApiKeyByHash.get(hash);
  if (keyRow) {
    await sql.touchApiKey.run(keyRow.id);
    return { companyId: keyRow.company_id, keyId: keyRow.id };
  }

  const globalKey = (process.env.AGENT_API_KEY || '').trim();
  if (globalKey) {
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(globalKey);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { companyId: null, legacyGlobal: true };
      }
    } catch {}
  }
  return { error: 'invalid api key', status: 401 };
}

app.post('/api/v1/agent/chat', agentLimiter, validate({ body: schemas.agentChatBody }), async (req, res) => {
  const auth = await resolveAgentApiAuth(req);
  if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });

  const bodyCompanyId = String(req.body?.company_id || '').trim();
  let companyId;
  if (auth.companyId) {
    // Company-scoped key: the key decides the tenant. A mismatched body
    // company_id is an integration bug or an attack — refuse loudly.
    if (bodyCompanyId && bodyCompanyId !== auth.companyId) {
      return res.status(403).json({ success: false, error: 'api key does not belong to this company' });
    }
    companyId = auth.companyId;
  } else {
    req.log.warn('agent api: legacy global AGENT_API_KEY used — migrate to per-company keys');
    companyId = bodyCompanyId;
  }

  const customerPhone = String(req.body?.customer_phone || '').trim();
  const message       = String(req.body?.message || '').trim();
  if (!COMPANY_ID_RE.test(companyId)) {
    return res.status(400).json({ success: false, error: 'company_id is required' });
  }
  // Pin the DB tenant context to the API key's company (Task #2 RLS).
  if (req.dbContext) { req.dbContext.bypass = false; req.dbContext.companyId = companyId; }
  if (!customerPhone) {
    return res.status(400).json({ success: false, error: 'customer_phone is required' });
  }
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  if (message.length > MAX_USER_MSG_CHARS) {
    return res.status(413).json({ success: false, error: 'message too long' });
  }

  const company = await loadCompany(companyId);
  if (!company) {
    return res.status(404).json({ success: false, error: 'company not found' });
  }
  if (!(await checkAndBumpUsage(company.id, 'agent_msgs', dailyCap(company, 'dailyMessageCap', 'DAILY_MSG_CAP', 2000)))) {
    return res.status(429).json({ success: false, error: 'daily message limit reached for this company' });
  }

  // Per-call variable substitutions (optional).
  const rawVars = req.body?.variables;
  const vars = {};
  if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
    for (const [k, v] of Object.entries(rawVars)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        vars[k] = String(v).slice(0, 200);
      }
    }
  }

  // Deterministic per-customer thread id. Derived from the phone number so a
  // returning customer lands in the same conversation without any stored
  // mapping that could expire or drift.
  const sessionId = 'api-' + customerPhone.replace(/[^0-9]/g, '');
  const history = await loadSessionHistory(company.id, sessionId);

  const t0 = Date.now();
  let reply = '';
  try {
    const r = await askGPT(company, message, history, vars);
    reply = String(r.reply || '').trim();
  } catch (e) {
    if (e.code === 'NO_ACTIVE_SCENARIO') {
      return res.status(409).json({ success: false, error: e.message, code: e.code });
    }
    req.log.error('agent api: chat failed', { err: e.message, companyId: company.id });
    return res.status(502).json({ success: false, error: 'agent unavailable' });
  }

  // Log to chats so the conversation shows up in the dashboard AND becomes the
  // history the next turn resumes from.
  try {
    await sql.insertChat.run({
      company_id     : company.id,
      session_id     : sessionId,
      user_message   : message,
      assistant_reply: reply || '',
      channel        : 'api',
      latency_ms     : Date.now() - t0,
      user_id        : null,
    });
  } catch (e) { req.log.error('agent api: chat insert failed', { err: e.message }); }

  res.json({
    success    : true,
    reply      : reply || '',
    // Kept for response-shape compatibility with existing integrations. It is
    // now our own stable thread id rather than a provider-issued one, so it no
    // longer expires — callers that echo it back are unaffected.
    chat_id    : sessionId,
    company_id : company.id,
    latency_ms : Date.now() - t0,
  });
});

// Everything else under /api/ requires authentication.
app.use('/api', requireAuth);

// Per-company client accounts (superadmin only — owners no longer exist).
app.use('/api/companies/:id/clients', clientsRoutes);

// Outbound campaigns + eval harness (both tenant-scoped via :id).
app.use('/api/companies/:id/campaigns', campaignsRoutes);
app.use('/api/companies/:id/evals', evalsRoutes);

// ─── helpers ─────────────────────────────────────────────────────
const COMPANY_ID_RE  = /^[a-z0-9-]{1,40}$/;
const MAX_HISTORY    = 20;        // max messages forwarded to the LLM per turn
const MAX_MSG_CHARS  = 2000;      // per-message cap
const MAX_USER_MSG_CHARS = 4000;  // per-user-turn cap

// Rebuild a conversation from the turns we already store, for channels where
// the client does not (and should not have to) send history back — the public
// Agent API and the Playground chat tab. Company-scoped: session_id alone is
// guessable, so the tenant is always part of the lookup.
//
// Capped at MAX_HISTORY messages, same as the client-supplied path, so a very
// long-running thread cannot grow the prompt without bound.
async function loadSessionHistory(companyId, sessionId) {
  if (!sessionId) return [];
  let rows = [];
  try {
    // Read only what can survive the MAX_HISTORY slice below. Each chat row
    // yields at most two messages (the user turn and the reply), so MAX_HISTORY
    // rows is always at least MAX_HISTORY messages — the same window as before,
    // without dragging a year of WhatsApp history through the process on every
    // turn. Rows come back newest-first and are reversed to chronological.
    rows = await sql.getSessionRecent.all(sessionId, companyId, MAX_HISTORY);
    rows = rows.slice().reverse();
  } catch (e) {
    logger.warn('history load failed — continuing without it', { err: e.message, companyId });
    return [];
  }
  const messages = [];
  for (const r of rows) {
    if (r.user_message) messages.push({ role: 'user', content: String(r.user_message).slice(0, MAX_MSG_CHARS) });
    if (r.assistant_reply) messages.push({ role: 'assistant', content: String(r.assistant_reply).slice(0, MAX_MSG_CHARS) });
  }
  return messages.slice(-MAX_HISTORY);
}

async function resolveCompany(req, res) {
  const companyId = String(req.body?.companyId || '');
  const message = String(req.body?.message || '');
  if (!companyId || !message) {
    res.status(400).json({ error: 'companyId and message are required' });
    return null;
  }
  if (!COMPANY_ID_RE.test(companyId)) {
    res.status(400).json({ error: 'invalid companyId' });
    return null;
  }
  if (message.length > MAX_USER_MSG_CHARS) {
    res.status(413).json({ error: 'message too long' });
    return null;
  }
  // Cap history strictly server-side. The client is untrusted.
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .slice(-MAX_HISTORY)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  const company = await loadCompany(companyId);
  if (!company) {
    res.status(404).json({ error: `Unknown companyId: ${companyId}` });
    return null;
  }
  // Per-call template variables. Keys are simple identifiers; values are
  // strings (truncated to avoid prompt bloat). Untrusted, so capped.
  const rawVars = req.body?.variables;
  const vars = {};
  if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
    for (const [k, v] of Object.entries(rawVars)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        vars[k] = String(v).slice(0, 200);
      }
    }
  }
  return { company, message, history, vars };
}

// audit() lives in lib/audit.js.

// Give a company exclusive ownership of a DID and/or an imported provider
// number, releasing whichever company held it before.
//
// A number identifies exactly ONE tenant: inbound calls are attributed back to
// a company through `phone_number` and `elevenlabs_phone_number_id`, so if two
// rows claim the same value a call cannot be attributed at all (the resolver
// refuses ambiguity rather than guessing). Transferring therefore has to clear
// the old owner in the SAME transaction that sets the new one — otherwise a
// crash in between leaves exactly the duplicated state we are preventing.
//
// The clear is scoped to THIS value and excludes the new owner, so no other
// company's row is touched.
//
// @returns {Promise<string[]>} ids of companies the number was taken from.
async function claimPhoneOwnership({ companyId, phoneNumber, phoneNumberId, log }) {
  const released = new Set();
  await withTransaction(async () => {
    if (phoneNumber) {
      const prior = await dataAll(
        'SELECT id FROM companies WHERE phone_number = ? AND id <> ?', [phoneNumber, companyId],
      );
      for (const r of prior) released.add(r.id);
      await sql.clearPhoneNumberOwner.run({ value: phoneNumber, keep: companyId });
    }
    if (phoneNumberId) {
      const prior = await dataAll(
        'SELECT id FROM companies WHERE elevenlabs_phone_number_id = ? AND id <> ?',
        [phoneNumberId, companyId],
      );
      for (const r of prior) released.add(r.id);
      await sql.clearElevenLabsPhoneOwner.run({ value: phoneNumberId, keep: companyId });
    }
    await sql.setCompanyElevenLabsPhone.run({
      id: companyId,
      phone_number_id: phoneNumberId ?? null,
      phone_number   : phoneNumber ?? null,
    });
  });
  if (released.size) {
    log?.warn?.('voice: phone number transferred between companies', {
      to: companyId, releasedFrom: [...released],
    });
  }
  return [...released];
}

async function askGPT(company, message, history, vars) {
  const systemContent = await buildSystemPromptWithRAG(company, message, vars);
  const messages = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: message },
  ];
  const t0 = Date.now();
  // Same model the live voice agent runs on — see resolveAgentModel().
  const m = resolveAgentModel(company);
  const completion = await openai.chat.completions.create({
    model: m.model, messages, max_tokens: m.maxTokens, temperature: m.temperature,
  });
  return { reply: completion.choices[0].message.content, ms: Date.now() - t0, usage: completion.usage };
}

// Compose the EXACT system prompt an assistant runs on for a given company +
// instruction prompt: scenario text (globals filled) + KB dump (capped) + the
// technical end-call wiring. Single source of truth shared by the voice
// publish, the draft tester, and the prompt preview — so what you test == what
// ships.
const KB_INJECT_CAP = 15000; // chars — headroom for a few docs of real content
// Chunks likely to carry the facts a caller asks about (prices, warranties,
// phone numbers). Kept first when the KB overflows the cap so key info isn't
// the part that gets truncated.
const KB_PRIORITY_RE = /[0-9٠-٩]|ريال|سعر|أسعار|السعر|ضمان|هاتف|جوال|رقم|مساحة|متر|نسبة|بالمئة|٪|%/;

// ─── Single source of truth for the agent's model settings ───────
// Every path that SIMULATES the live agent (voice sync, draft tester, text
// chat) must resolve the model the same way, or an operator tunes wording
// against behaviour that will never ship. Previously the draft tester ran
// gpt-4o-mini@0.6 and /chat ran gpt-4o-mini@0.7 while production voice ran
// gpt-4.1@0.3 — same prompt, three different models.
//
// Deliberately NOT routed through here (they are meta-tasks, not the agent):
//   - scenario generation  (writes a scenario; gpt-4o-mini is sufficient)
//   - eval judge           (services/evals.js — grading must stay independent
//                           of the model under test, or it grades itself)
//   - transcript summarize (summarize.js — post-call batch work)
// The provider accepts its own hosted models alongside OpenAI's. gemini flash
// lite is listed because a company is live on it: one short sentence per turn
// at 120 tokens, and markedly faster on a scripted flow.
const ALLOWED_MODELS = ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini', 'gemini-3.1-flash-lite'];
const clampNum = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);

function resolveAgentModel(company) {
  const s = company?.settings || {};
  return {
    model      : ALLOWED_MODELS.includes(s.model) ? s.model : 'gpt-4.1',
    temperature: clampNum(s.temperature, 0, 1, 0.3),
    maxTokens  : clampNum(s.maxTokens, 50, 800, 400),
  };
}
async function composeSystemPrompt(company, instructionPrompt) {
  let systemContent = fillGlobals(instructionPrompt || '', company);

  // The company's own FACTS, between the operator's instructions and the bulk
  // knowledge base. Curated and short, so it goes first; the KB is documents,
  // so it goes after. Renders to '' when the operator has filled nothing in,
  // which keeps the output byte-identical to before for every such company.
  // Behaviour stays operator-authored — this block states data only.
  systemContent += renderFactsBlock(company, company.businessProfile);

  const chunks = await sql.listAllChunksForCompany.all(company.id);
  if (chunks.length) {
    const header = '\n\n---\n\n## قاعدة معرفة الشركة\n\nاستخدم المعلومات التالية كمصدر حقائق رسمي. لا تختلق أسعاراً أو معلومات غير موجودة هنا:\n\n';
    const segs = chunks.map((ch, i) => ({
      order: i,
      priority: KB_PRIORITY_RE.test(ch.text) ? 1 : 0,
      text: `\n### ${ch.filename} — مقطع ${ch.chunk_index}\n${ch.text}\n`,
    }));
    const totalLen = header.length + segs.reduce((n, s) => n + s.text.length, 0);
    // Only reorder when we'd otherwise truncate — keeps natural doc order when
    // everything fits, but protects price/fact chunks when it doesn't.
    const ordered = totalLen <= KB_INJECT_CAP
      ? segs
      : segs.slice().sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    let kbBlock = header;
    let used = kbBlock.length;
    for (const s of ordered) {
      if (used + s.text.length > KB_INJECT_CAP) continue; // skip, keep scanning smaller ones
      kbBlock += s.text;
      used += s.text.length;
    }
    systemContent += kbBlock;
  }
  systemContent += END_CALL_TOOL_RULE;
  return systemContent;
}

function getOrMakeSessionId(req) {
  return req.body?.sessionId || req.headers['x-session-id'] || crypto.randomUUID();
}

// ─── Public routes ───────────────────────────────────────────────
// The marketing site. Plain static files under site/ — no build step, no
// JavaScript, and no shared styling with the admin SPA, so nothing here can
// affect /admin or /c/<id>. Mounted before the root route so its stylesheet
// resolves; `/` then serves the page itself rather than redirecting to the
// dashboard, which is no longer the front door.
app.use('/site', express.static(path.join(__dirname, 'site'), { index: false }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'site', 'index.html')));
// Clean URLs for the two legal pages. They are linked from the footer of every
// public page and referenced from the policies themselves, so the path has to
// stay stable and readable rather than carrying a .html suffix.
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'site', 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'site', 'terms.html')));

// Health check that actually checks. 503 only on hard DB failure (so a
// platform health-gate restarts us); soft issues (webhook backlog) are
// reported in the body for the uptime monitor to alert on. Deliberately no
// secrets/config details — this endpoint is unauthenticated.
const BOOTED_AT = Date.now();
app.get('/health', async (_req, res) => {
  const out = {
    ok        : true,
    uptime_sec: Math.round((Date.now() - BOOTED_AT) / 1000),
    version   : (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev',
    driver    : isPg ? 'postgres' : 'sqlite',
  };
  try {
    await healthCheck();
    out.db = 'ok';
    metrics.recordDbUp(true);
  } catch (e) {
    metrics.recordDbUp(false);
    logger.error('health: db check failed', { err: e.message });
    return res.status(503).json({ ok: false, db: 'fail' });
  }
  try {
    out.webhook_pending = (await sql.countWebhooksByStatus.get('pending')).n;
    out.webhook_failed  = (await sql.countWebhooksByStatus.get('failed')).n;
    if (out.webhook_pending > 50) out.degraded = 'webhook backlog';
  } catch {}
  // Backup signal for the uptime monitor: 'off' (not configured), 'ok',
  // 'stale' (configured but no successful run in 2 intervals), 'error'.
  const bk = getBackupStatus();
  if (!bk.configured) out.backup = 'off';
  else if (bk.lastError && !bk.lastOkAt) out.backup = 'error';
  else if (!bk.lastOkAt) out.backup = 'pending';
  else {
    const intervalMs = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 24) * 3600 * 1000;
    out.backup = (Date.now() - new Date(bk.lastOkAt).getTime()) > 2 * intervalMs ? 'stale' : 'ok';
  }
  // RLS rollout signal (Task #2). `armed` = this process is sending tenant
  // context on every query; `tables_enforced` = how many tables Postgres is
  // actually policing. Both must read correctly BEFORE the policies are
  // enabled, and they stay visible afterwards as ongoing observability
  // (an uptime monitor can alert if enforcement silently drops to 0).
  out.rls = { armed: process.env.RLS_ENABLED === '1' };
  if (isPg) {
    try {
      const r = await dataGet("SELECT count(*) FILTER (WHERE rowsecurity)::int AS n FROM pg_tables WHERE schemaname = 'public'");
      out.rls.tables_enforced = Number(r?.n ?? 0);
    } catch { /* non-fatal: never fail the health check on a catalog probe */ }
  }
  // Campaign worker heartbeat — proves the outbound scheduler is executing.
  // `healthy:false` here (or a stale lastTickAt) is the direct answer to
  // "why are my campaigns stuck pending?" when the worker isn't running.
  try {
    const w = getCampaignWorkerHealth();
    out.campaign_worker = {
      mode: w.mode, healthy: w.healthy, lastTickAt: w.lastTickAt,
      ticks: w.ticks, running: w.lastRunningCount, lastPlaced: w.lastPlaced,
      ...(w.lastError ? { lastError: w.lastError } : {}),
    };
    if (!w.healthy) out.degraded = 'campaign worker not ticking';
  } catch { /* non-fatal */ }
  res.json(out);
});

// Liveness probe: process is up, no dependency checks (for k8s/uptime liveness).
app.get('/livez', (_req, res) => res.json({ ok: true, uptime_sec: Math.round((Date.now() - BOOTED_AT) / 1000) }));

// Prometheus scrape endpoint (Task #6). Gate with METRICS_TOKEN in production.
app.get('/metrics', metrics.metricsHandler);

app.post('/chat', chatLimiter, requireAuth, async (req, res) => {
  const ctx = await resolveCompany(req, res);
  if (!ctx) return;
  if (!canChatWithCompany(req.user, ctx.company.id)) {
    return res.status(403).json({ error: 'لا تملك صلاحية محادثة هذه الشركة' });
  }
  if (!(await checkAndBumpUsage(ctx.company.id, 'chat_msgs', dailyCap(ctx.company, 'dailyMessageCap', 'DAILY_MSG_CAP', 2000)))) {
    return res.status(429).json({ error: 'تم بلوغ الحد اليومي للرسائل لهذه الشركة. حاول غداً أو ارفع الحد من الإعدادات.' });
  }
  const sessionId = getOrMakeSessionId(req);
  try {
    const r = await askGPT(ctx.company, ctx.message, ctx.history, ctx.vars);
    await sql.insertChat.run({
      company_id: ctx.company.id, session_id: sessionId,
      user_message: ctx.message, assistant_reply: r.reply,
      channel: 'text', latency_ms: r.ms,
      user_id: req.user.id,
    });
    res.setHeader('X-Session-Id', sessionId);
    res.json({ company: ctx.company.name, sessionId, reply: r.reply, ms: r.ms, usage: r.usage });
  } catch (err) {
    if (err.code === 'NO_ACTIVE_SCENARIO') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    req.log.error('GPT error', { err: err.message, companyId: ctx.company.id });
    res.status(500).json({ error: err.message });
  }
});

// Playground voice catalog. Whitelist — only these IDs can be requested from
// /chat-voice, so a tampered client can't bill an arbitrary ElevenLabs voice.
// Arabic male voices on the account.
// Global default voice for every agent. Code is the source of truth (not the
// Railway env var) so a stale ELEVENLABS_VOICE_ID can't silently override it.
// Per-company overrides still win via settings.voiceId (set in the admin UI).
const DEFAULT_VOICE_ID = 'MI88rOZjXbH22N8KHXUo'; // Ali علي — الصوت الافتراضي (مختبَر وجيد)

// Voice pacing default applied at every publish (env-tunable, no deploy):
// speed 1.2 (faster speech), per the operator's request. Clamped to the valid
// ElevenLabs range.
//
// The companion `optimizeStreamingLatency` knob is gone: it was a property of
// the previous provider's TTS bridge, and the Agents TTS config has no such
// field. Sending it would be rejected, so it is removed rather than renamed.
// Voice models a company may select. Confirmed against GET /v1/models — each
// one reports Arabic support. The expressive line is what expressiveMode acts
// on; on the rest the flag is stored and ignored.
const ALLOWED_TTS_MODELS = [
  'eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_multilingual_v2',
  'eleven_v3', 'eleven_v3_conversational', 'eleven_v4', 'eleven_v4_turbo',
];

const VOICE_SPEED_DEFAULT   = clampRange(process.env.VOICE_SPEED_DEFAULT, 0.7, 1.2, 1.2);
function clampRange(v, lo, hi, dflt) {
  return Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt;
}

const PLAYGROUND_VOICES = [
  { id: 'MI88rOZjXbH22N8KHXUo', name: 'Ali', label: 'علي', description: 'صوت هادئ وواضح', gender: 'male', accent: 'arabic' },
  { id: 'cFUFIbKkO2iZFwS8cRnY', name: 'Nasser', label: 'ناصر', description: 'صوت سعودي طبيعي', gender: 'male', accent: 'saudi' },
  // Name and description read from GET /v1/voices, not invented. A live
  // company already runs on this voice.
  { id: 'yXEnnEln9armDCyhkXcA', name: 'Jeddawi', label: 'جداوي', description: 'صوت سعودي عميق وواثق', gender: 'male', accent: 'saudi' },
];
const PLAYGROUND_VOICE_IDS = new Set(PLAYGROUND_VOICES.map((v) => v.id));

// Voices a company may select in settings. The Playground catalog plus any
// ids added via EXTRA_VOICE_IDS (comma-separated) so a new ElevenLabs voice
// can be enabled from Railway without a code change.
const EXTRA_VOICE_IDS = new Set(
  String(process.env.EXTRA_VOICE_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
function isAllowedVoiceId(id) {
  const v = String(id || '').trim();
  if (!v) return false;
  return PLAYGROUND_VOICE_IDS.has(v) || EXTRA_VOICE_IDS.has(v);
}

app.get('/api/voices', requireAuth, async (_req, res) => {
  res.json(PLAYGROUND_VOICES);
});

// Outbound call: the provider rings the customer's phone THROUGH this
// company's own imported 3CX number, using this company's own agent. No audio
// in the browser at all — the full leg is SIP, so what the Playground exercises
// is the real production path: same prompt, same voice, same telephony.
app.post('/api/companies/:id/outbound-call', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'company not found' });
  if (!c.agentId) {
    return res.status(409).json({ error: 'انشر الشركة على ElevenLabs أولاً.', code: 'NOT_PUBLISHED' });
  }
  // Each company dials from its OWN number. There is deliberately NO
  // platform-wide fallback: with multiple tenants, falling back would place
  // one company's calls on another company's line.
  if (!c.phoneNumberId) {
    return res.status(503).json({
      error: 'رقم الشركة غير مستورد إلى ElevenLabs بعد — استورد رقم 3CX الخاص بها أولاً.',
      code : 'NO_PHONE_NUMBER_ID',
    });
  }
  if (!(await checkAndBumpUsage(c.id, 'outbound_calls', dailyCap(c, 'dailyOutboundCap', 'DAILY_OUTBOUND_CAP', 200)))) {
    return res.status(429).json({ error: 'تم بلوغ الحد اليومي للمكالمات الصادرة لهذه الشركة.' });
  }
  const phoneNumber = String(req.body?.phoneNumber || '').trim();
  // E.164 format: +<country><number>, total 8–15 digits after the plus.
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'رقم تليفون غير صالح. الصيغة: +966XXXXXXXXX' });
  }
  const rawVars = req.body?.variableValues;
  const vars = {};
  if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
    for (const [k, v] of Object.entries(rawVars)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        vars[k] = String(v).slice(0, 200);
      }
    }
  }

  // Outbound opening line: the scenario's outbound first_message (which knows
  // who we are calling) instead of the inbound greeting baked into the agent.
  // {{customer_name}} and friends are interpolated by the provider from the
  // dynamic variables above. This override only takes effect because the sync
  // enables first_message in platform_settings.overrides.
  const activeScenario = await sql.getActiveScenarioForCompany.get(c.id);
  // Same unresolved-{{agent_name}} trap as the publish path: an override sent
  // with a global still in it makes the provider refuse the call outright.
  const firstMessage = fillGlobals(activeScenario?.first_message || null, c);

  try {
    const { callId, callRef, status } = await voice.startOutboundCall({
      company: c, toNumber: phoneNumber, variables: vars, firstMessage,
    });
    // Pre-register the call so it appears in Conversations immediately, even
    // before the post-call webhook arrives. That webhook's upsert fills in
    // transcript/duration/cost when the call ends.
    try {
      await sql.insertOutboundCallStub.run({
        id            : callId,
        company_id    : c.id,
        assistant_id  : c.agentId,
        caller_number : encryptField(phoneNumber),
        provider      : c.voiceProvider,
        provider_call_ref: callRef,
      });
    } catch (e) {
      req.log.error('outbound-call stub insert failed', { err: e.message });
    }
    audit(req, 'playground.outbound', `calls/${callId}`, { phoneNumber, companyId: c.id });
    res.json({ callId, status });
  } catch (e) {
    const detail = voice.errText(e);
    req.log.error('outbound-call error', { err: detail, companyId: c.id });
    res.status(502).json({ error: String(detail).slice(0, 300) });
  }
});

// Text chat against the company's scenario (no audio). Lets an operator test
// wording without placing a phone call.
//
// Runs the SAME composed prompt, the SAME RAG retrieval and the SAME model
// that the voice agent is published with — buildSystemPromptWithRAG() and
// resolveAgentModel() are the single sources of truth for both channels. It is
// executed locally rather than through the provider because the Agents platform
// has no synchronous text endpoint; its text channel answers by webhook, which
// a request/response UI cannot use.
app.post('/api/companies/:id/assistant-chat', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'company not found' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  if (message.length > MAX_USER_MSG_CHARS) return res.status(413).json({ error: 'message too long' });
  // Stable client-supplied session id groups every turn of one Playground
  // conversation into a single row on the Conversations page. Falls back to
  // a fresh id if the client didn't send one (each turn would then be its
  // own session — acceptable but not ideal).
  const sessionId = String(req.body?.sessionId || '').slice(0, 80) || ('pg-' + crypto.randomUUID());
  const rawVars = req.body?.variableValues;
  const vars = {};
  if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
    for (const [k, v] of Object.entries(rawVars)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        vars[k] = String(v).slice(0, 200);
      }
    }
  }

  const t0 = Date.now();
  try {
    const history = await loadSessionHistory(c.id, sessionId);
    const r = await askGPT(c, message, history, vars);
    const reply = String(r.reply || '').trim();
    // Persist the turn so the Playground chat shows up in Conversations like
    // every other channel. channel='text' marks it as an internal test chat.
    try {
      await sql.insertChat.run({
        company_id     : c.id,
        session_id     : sessionId,
        user_message   : message,
        assistant_reply: reply || '',
        channel        : 'text',
        latency_ms     : Date.now() - t0,
        user_id        : req.user?.id || null,
      });
    } catch (e) { req.log.error('assistant-chat: chat insert failed', { err: e.message }); }
    res.json({ chatId: sessionId, reply, sessionId });
  } catch (e) {
    if (e.code === 'NO_ACTIVE_SCENARIO') {
      return res.status(409).json({ error: e.message, code: e.code });
    }
    req.log.error('assistant-chat error', { err: e.message, companyId: c.id });
    res.status(502).json({ error: String(e.message).slice(0, 300) });
  }
});

// /chat-voice, /stt, /tts were the old browser-only voice pipeline. Voice now
// happens entirely over SIP/telephony, so these routes stay gone. The /chat
// (text) endpoint above remains for non-voice scenarios + tests.

// The provider webhook pipeline lives in routes/webhook.js (verification +
// inbox) and services/call-events.js (event -> calls row + drain).
app.use('/webhook', webhookRoutes);
startDrainTimer();
startCampaignWorker();
// PDPL retention. No-op unless RETENTION_DAYS_* is configured (audit F-04a).
startRetentionWorker();

// ─── Admin: backfill recent calls from the provider ──────────────
// Superadmin-only. Pulls the most recent conversations straight from the
// provider's REST API and upserts them, catching anything the webhook missed
// (inbound or outbound) — e.g. a period where the webhook secret was wrong and
// every delivery 401'd. Safe to run anytime; the upsert is idempotent on call
// id, so re-running only fills gaps.
app.get('/api/_admin/sync-calls', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not set' });
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const { fetched, matched } = await backfillRecentCalls(limit);
    audit(req, 'admin.sync_calls', null, { fetched, matched });
    res.json({ success: true, fetched, matched, unmatched: fetched - matched });
  } catch (e) {
    const detail = voice.errText(e);
    req.log.error('sync-calls failed', { err: detail });
    res.status(502).json({ success: false, error: detail });
  }
});

// ─── Admin: SQLite backup snapshot ───────────────────────────────
// Superadmin-only. Returns a binary-consistent snapshot of data.db so the
// operator can save a copy before risky changes (Railway volume swap,
// schema migration, etc.). db.serialize() runs a synchronous in-process
// snapshot — safe with WAL mode, no torn writes mid-transaction.
app.get('/api/_admin/backup', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  if (isPg) return res.status(400).json({ error: 'binary snapshot is sqlite-only — use /api/_admin/backup-now (offsite) on postgres' });
  try {
    const snapshot = db.serialize();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="smart-assistant-${stamp}.db"`);
    res.setHeader('Content-Length', String(snapshot.length));
    audit(req, 'admin.backup', null, { sizeBytes: snapshot.length });
    res.send(snapshot);
  } catch (e) {
    req.log.error('backup failed', { err: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: offsite backup status + manual trigger ───────────────
app.get('/api/_admin/backup-status', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  res.json(getBackupStatus());
});

app.post('/api/_admin/backup-now', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await runBackup(req.log);
    audit(req, 'admin.backup_offsite', null, r);
    res.json({ success: true, ...r });
  } catch (e) {
    res.status(503).json({ success: false, error: e.message });
  }
});

// ─── Admin: audit log (read side) ────────────────────────────────
app.get('/api/_admin/audit', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  let rows = await sql.listAuditEvents.all(limit);
  const action = String(req.query.action || '').trim();
  if (action) rows = rows.filter((r) => (r.action || '').startsWith(action));
  res.json(rows);
});

// ─── Debug: recent webhook attempts ──────────────────────────────
// Superadmin only. Returns the last 10 webhook attempts (headers sanitized)
// plus a fingerprint of each signing secret as configured on this server, so
// the operator can spot a mismatch between the secret the provider signs with
// and the one this deployment holds — without either value being printed.
//
// BOTH secrets are reported because the post-call and conversation-initiation
// webhooks are separate resources in the workspace, each issued its own secret.
// Reporting only the post-call one sent an operator debugging an init 401 to
// compare against a secret that request was never signed with.
app.get('/api/_debug/recent-webhooks', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  const fingerprint = (raw = '') => {
    const trimmed = raw.trim();
    return {
      raw_length    : raw.length,
      trimmed_length: trimmed.length,
      first8        : trimmed.slice(0, 8),
      last4         : trimmed.slice(-4),
      has_whitespace: raw.length !== trimmed.length,
    };
  };
  const post = process.env.ELEVENLABS_WEBHOOK_SECRET || '';
  const init = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET || '';
  res.json({
    // Unchanged key: this is the post-call secret, as before.
    serverEnv: fingerprint(post),
    // Which secret /webhook/elevenlabs/init verifies against, and how. That
    // endpoint is NOT HMAC-signed by the provider: authentication is the
    // constant header named here, which must be registered in the webhook's
    // `request_headers` with exactly this value. `falls_back` means
    // ELEVENLABS_INIT_WEBHOOK_SECRET is unset and the post-call secret is
    // standing in for it.
    initWebhookEnv: {
      configured: !!init.trim(),
      falls_back: !init.trim(),
      header    : voice.DRIVERS.elevenlabs.INIT_TOKEN_HEADER,
      ...fingerprint(init.trim() ? init : post),
    },
    attempts: getRecentWebhookAttempts(),
  });
});

// ─── Admin API ───────────────────────────────────────────────────
app.get('/api/companies', async (req, res) => {
  // Clients see only their own workspace; superadmins see everything.
  const all = await listCompaniesFull();
  const list = req.user.role === 'superadmin'
    ? all
    : all.filter((c) => c.id === req.user.companyId);
  // Per-company stats in a single query.
  const statsRows = await sql.companiesStats.all();
  const statsMap = new Map(statsRows.map((r) => [r.company_id, r]));
  res.json(list.map((c) => ({
    ...c,
    stats: {
      chats        : statsMap.get(c.id)?.chats || 0,
      calls        : statsMap.get(c.id)?.calls || 0,
      lastActivity : statsMap.get(c.id)?.last_activity || null,
    },
  })));
});

app.get('/api/companies/:id', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  // Return the raw stored system_prompt and kb_text (not the composed prompt).
  const row = await sql.getCompany.get(req.params.id);
  res.json({ ...c, systemPrompt: row.system_prompt, kbText: row.kb_text });
});

// Per-company voice + model settings. Whitelist keys so a client can't inject
// arbitrary config; values are re-clamped at sync time regardless.
app.patch('/api/companies/:id/settings', requireCompanyAccess, validate({ params: schemas.companyIdParam, body: schemas.settingsBody }), async (req, res) => {
  const row = await sql.getCompany.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const clean = {};
  // Voice must be one we actually have on the ElevenLabs account. An
  // unvalidated id is accepted here but only fails much later, at publish
  // time, as "Couldn't Find Voice" — which is exactly the production
  // incident this guards against. EXTRA_VOICE_IDS lets an operator add a new
  // voice without a deploy.
  if (typeof b.voiceId === 'string') {
    const v = b.voiceId.trim();
    if (!isAllowedVoiceId(v)) {
      return res.status(400).json({ error: 'معرّف الصوت غير معروف. اختر صوتاً من القائمة المتاحة.', voiceId: v });
    }
    clean.voiceId = v;
  }
  if (ALLOWED_MODELS.includes(b.model)) clean.model = b.model;
  for (const k of ['temperature', 'maxTokens', 'stability', 'similarityBoost', 'voiceSpeed']) {
    if (b[k] !== undefined && Number.isFinite(Number(b[k]))) clean[k] = Number(b[k]);
  }
  // Voice-engine settings that publishing overwrites, so the company must own
  // them or they are lost on the next publish. Allow-listed rather than free
  // text: an unknown model id surfaces only at publish time, as an opaque
  // provider error, long after the operator left this screen.
  if (ALLOWED_TTS_MODELS.includes(b.ttsModel)) clean.ttsModel = b.ttsModel;
  if (typeof b.expressiveMode === 'boolean') clean.expressiveMode = b.expressiveMode;
  for (const k of ['turnTimeoutSeconds', 'silenceEndCallSeconds']) {
    if (b[k] !== undefined && Number.isFinite(Number(b[k]))) clean[k] = Number(b[k]);
  }
  // Spending caps are the platform's cost circuit-breaker (services/usage.js
  // reads settings BEFORE the env default), so the tenant they limit must not
  // be able to raise them. Superadmin-only; a client sending these gets 403
  // rather than a silent drop, so a broken integration is visible.
  const CAP_KEYS = ['dailyMessageCap', 'dailyOutboundCap'];
  const attemptedCaps = CAP_KEYS.filter((k) => b[k] !== undefined);
  if (attemptedCaps.length) {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'تعديل الحدود اليومية متاح للمسؤول فقط', keys: attemptedCaps });
    }
    for (const k of attemptedCaps) {
      if (Number.isFinite(Number(b[k]))) clean[k] = Number(b[k]);
    }
  }
  // The company's imported ElevenLabs phone number. ONE id per company: the
  // same 3CX DID answers inbound and is the caller ID on outbound, so the old
  // in/out split no longer exists. It lives in a column rather than settings
  // JSON because the webhook path resolves tenants by it and needs an index.
  // Superadmin-only: it is the binding between a tenant and a real phone line,
  // and a client repointing it would hijack another company's number.
  let elevenlabsPhoneNumberId;
  if (typeof b.elevenlabsPhoneNumberId === 'string') {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'ربط رقم الهاتف متاح للمسؤول فقط' });
    }
    elevenlabsPhoneNumberId = b.elevenlabsPhoneNumberId.trim().slice(0, 80);
  }
  // Human-transfer number (E.164, e.g. +9665xxxxxxxx). Empty string clears it.
  if (typeof b.transferPhoneNumber === 'string') {
    const t = b.transferPhoneNumber.trim();
    if (t === '' || /^\+[0-9]{8,15}$/.test(t)) clean.transferPhoneNumber = t;
    else return res.status(400).json({ error: 'رقم التحويل يجب أن يكون بصيغة دولية مثل +9665xxxxxxxx' });
  }
  // Outgoing webhook (call.completed). Empty string clears. The URL is
  // SSRF-checked here so the operator gets an immediate reason; it is checked
  // AGAIN at send time against live DNS (services/outbound-webhook.js).
  if (typeof b.webhookUrl === 'string') {
    const u = b.webhookUrl.trim();
    if (u === '') {
      clean.webhookUrl = '';
    } else if (u.length > 300) {
      return res.status(400).json({ error: 'رابط الـ webhook طويل جداً' });
    } else {
      const safe = isSafeUrl(u);
      if (!safe.ok) return res.status(400).json({ error: `رابط الـ webhook غير صالح: ${safe.reason}` });
      clean.webhookUrl = u;
    }
  }
  if (typeof b.webhookSecret === 'string') clean.webhookSecret = b.webhookSecret.trim().slice(0, 128);
  // Merge over the existing settings: a partial PATCH (one key) must not
  // wipe the rest (caps, voice tuning...).
  let existing = {};
  try { if (row.settings) existing = JSON.parse(row.settings) || {}; } catch {}
  const merged = { ...existing, ...clean };
  await sql.updateCompanySettings.run({ id: row.id, settings: JSON.stringify(merged) });
  if (elevenlabsPhoneNumberId !== undefined) {
    // Same exclusivity rule as the import path: setting an id another company
    // already holds transfers it rather than creating a duplicate claim.
    const released = await claimPhoneOwnership({
      companyId: row.id, phoneNumberId: elevenlabsPhoneNumberId || null, log: req.log,
    });
    audit(req, 'voice.phone_number_set', `companies/${row.id}`, {
      phoneNumberId: elevenlabsPhoneNumberId,
      releasedFrom : released.length ? released : undefined,
    });
  }
  invalidateCache();
  audit(req, 'company.settings', `companies/${row.id}`, Object.keys(clean));
  res.json({ settings: merged, elevenlabsPhoneNumberId: elevenlabsPhoneNumberId ?? row.elevenlabs_phone_number_id ?? null });
});

// ─── Per-company API keys (public Agent API) ─────────────────────
// Superadmin-only. The plaintext key is returned ONCE at creation; only its
// SHA-256 hash is stored, so there is no way to re-display it later.
app.post('/api/companies/:id/api-keys', requireCompanyAdmin, validate({ body: schemas.apiKeyCreateBody }), async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80) || 'default';
  const raw = 'sa_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 10);
  const r = await sql.insertApiKey.run({ company_id: req.params.id, name, key_hash: keyHash, prefix });
  audit(req, 'apikey.create', `companies/${req.params.id}`, { keyId: Number(r.lastInsertRowid), name });
  res.status(201).json({
    id: Number(r.lastInsertRowid), name, prefix,
    key: raw,   // shown once — the UI must tell the user to copy it now
  });
});

app.get('/api/companies/:id/api-keys', requireCompanyAdmin, async (req, res) => {
  res.json(await sql.listApiKeysForCompany.all(req.params.id));
});

app.delete('/api/companies/:id/api-keys/:keyId', requireCompanyAdmin, async (req, res) => {
  const r = await sql.revokeApiKey.run(Number(req.params.keyId), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'key not found or already revoked' });
  audit(req, 'apikey.revoke', `companies/${req.params.id}`, { keyId: Number(req.params.keyId) });
  res.json({ ok: true });
});

app.post('/api/companies', validate({ body: schemas.companyCreateBody }), async (req, res) => {
  const b = req.body || {};
  // systemPrompt + kbText are legacy — Scenarios replaced them. Kept for old
  // companies that still have them set; we don't require them at creation.
  if (!b.id || !b.name) {
    return res.status(400).json({ error: 'id and name are required' });
  }
  if (!COMPANY_ID_RE.test(b.id)) {
    return res.status(400).json({ error: 'id must be lowercase letters/digits/hyphens (max 40)' });
  }
  if (await sql.getCompany.get(b.id)) return res.status(409).json({ error: 'id already exists' });
  await sql.insertCompany.run({
    id            : b.id,
    user_id       : req.user.id,
    name          : b.name,
    language      : b.language || 'ar-SA',
    voice_id      : b.voiceId || DEFAULT_VOICE_ID,
    phone_number  : b.phoneNumber || null,
    system_prompt : b.systemPrompt || '',
    kb_text       : b.kbText || null,
  });
  invalidateCache(b.id);
  audit(req, 'company.create', `companies/${b.id}`, { name: b.name });
  res.status(201).json(await loadCompany(b.id));
});

app.patch('/api/companies/:id', requireCompanyAccess, validate({ body: schemas.companyPatchBody }), async (req, res) => {
  const existing = await sql.getCompany.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  // The provider agent id is deliberately NOT accepted here. It is owned by
  // the publish path, so no PATCH can repoint one company at another
  // company's agent — which would send that tenant's calls to the wrong
  // prompt and the wrong knowledge base.
  await sql.updateCompany.run({
    id            : existing.id,
    name          : b.name          ?? existing.name,
    language      : b.language      ?? existing.language,
    voice_id      : b.voiceId       ?? existing.voice_id,
    phone_number  : b.phoneNumber   ?? existing.phone_number,
    system_prompt : b.systemPrompt  ?? existing.system_prompt,
    kb_text       : b.kbText        ?? existing.kb_text,
  });
  invalidateCache(existing.id);
  audit(req, 'company.update', `companies/${existing.id}`, Object.keys(b));
  res.json(await loadCompany(existing.id));
});

app.delete('/api/companies/:id', requireCompanyAdmin, async (req, res) => {
  const r = await sql.deleteCompany.run(req.params.id);
  invalidateCache(req.params.id);
  audit(req, 'company.delete', `companies/${req.params.id}`);
  res.json({ deleted: r.changes });
});

// Chat sessions + calls per company.
app.get('/api/companies/:id/sessions', requireCompanyAccess, async (req, res) => {
  res.json(await sql.listSessionsForCompany.all(req.params.id, Number(req.query.limit) || 50));
});

// Verify the session belongs to a company the user can access.
// Authorization mirrors requireCompanyAccess EXACTLY: superadmins see
// everything, a client sees only the company on their own user row.
// (This used to test `companies.user_id = req.user.id` — the legacy "owner"
// model. Client users are linked the other way, via users.company_id, so that
// check could never pass and every client got a 404 on conversation details.)
function userCanAccessCompany(user, companyId) {
  if (!user || !companyId) return false;
  if (user.role === 'superadmin') return true;
  return user.role === 'client' && !!user.companyId && user.companyId === companyId;
}

async function ensureSessionOwned(req, res, next) {
  const row = await dataGet('SELECT DISTINCT company_id FROM chats WHERE session_id = ?', [req.params.sessionId]);
  if (!row) return res.status(404).json({ error: 'session not found' });
  if (!userCanAccessCompany(req.user, row.company_id)) {
    return res.status(404).json({ error: 'session not found' });
  }
  req._sessionCompanyId = row.company_id;   // scopes the follow-up queries
  next();
}

app.get('/api/sessions/:sessionId', ensureSessionOwned, async (req, res) => {
  res.json(await sql.getSession.all(req.params.sessionId, req._sessionCompanyId));
});

app.post('/api/sessions/:sessionId/summarize', ensureSessionOwned, async (req, res) => {
  const rows = await sql.getSession.all(req.params.sessionId, req._sessionCompanyId);
  if (!rows.length) return res.status(404).json({ error: 'session not found' });
  const transcript = chatToTranscript(rows);
  const summary = await summarize(transcript);
  if (summary) await sql.setSessionSummary.run(summary, req.params.sessionId, req._sessionCompanyId);
  res.json({ summary });
});

app.get('/api/companies/:id/calls', requireCompanyAccess, async (req, res) => {
  const rows = await sql.listCallsForCompany.all(req.params.id, Number(req.query.limit) || 50);
  res.json(decryptRows(rows, CALL_PII_FIELDS));
});

// Verify the call belongs to a company the user can access. Same authorization
// rule as ensureSessionOwned / requireCompanyAccess — see the note above.
async function ensureCallOwned(req, res, next) {
  const c = await sql.getCall.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!userCanAccessCompany(req.user, c.company_id)) {
    return res.status(404).json({ error: 'not found' });
  }
  req._call = c;
  next();
}

app.get('/api/calls/:id', ensureCallOwned, async (req, res) => {
  let call = req._call;
  // If the row is a stub (no transcript or no ended_reason yet), pull the
  // latest state from the provider and upsert. Covers two cases:
  //   1. Outbound call we just initiated — the webhook hasn't arrived yet.
  //   2. The webhook arrived but never reached us (misconfigured URL,
  //      signature mismatch...). Without this the row stays a permanent stub.
  const needsRefresh = (!call.transcript || !call.ended_reason) && process.env.ELEVENLABS_API_KEY;
  if (needsRefresh) {
    try {
      call = await refreshCall(call);
    } catch (e) {
      req.log.warn('call refresh failed', { err: voice.errText(e), callId: call.id });
    }
  }
  res.json(decryptRow(call, CALL_PII_FIELDS));
});

app.post('/api/calls/:id/summarize', ensureCallOwned, async (req, res) => {
  const c = req._call;
  const summary = await summarize(c.transcript || '');
  if (summary) await sql.setCallSummary.run(summary, c.id);
  res.json({ summary });
});

// Stream a call's audio recording through our own backend.
//
// Why proxy rather than hand the browser a storage URL: audio is fetched from
// the provider with OUR api key, which must never reach a client. Proxying
// also means there is no presigned link to expire — the previous provider
// handed out URLs that returned a raw storage error once they aged out, which
// is the bug this endpoint was originally written to fix. Range is forwarded
// so the <audio> element can seek. Tenant-scoped via ensureCallOwned.
app.get('/api/calls/:id/recording', ensureCallOwned, async (req, res) => {
  const call = req._call;
  try {
    const upstream = await voice.fetchRecording(call, { range: req.headers.range });
    if (!upstream) return res.status(404).json({ error: 'لا يوجد تسجيل لهذه المكالمة' });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    if (!upstream.headers['content-type']) res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="call-${call.id}.mp3"`);
    upstream.stream.on('error', () => { try { res.destroy(); } catch {} });
    upstream.stream.pipe(res);
  } catch (e) {
    req.log.error('recording proxy failed', { err: voice.errText(e), callId: call.id });
    if (!res.headersSent) res.status(502).json({ error: 'تعذّر جلب تسجيل المكالمة' });
  }
});

// Publish: rebuild this company's voice agent from its ACTIVE SCENARIO.
// Everything that matters — system prompt, first message, success criteria,
// variable list — comes from the scenario row. Pressing this button is the
// only thing that should change what callers hear on the phone, so the
// /admin Scenarios page is the only source of truth.
//
// Route name is provider-neutral on purpose: the provider is an implementation
// detail of services/voice, not something the admin UI should have to know.
async function handlePublishCompany(req, res) {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  // Optional override: ?force=1 wipes the stored agent id before publishing,
  // forcing a clean rebuild. Useful when the agent was deleted from the
  // provider's dashboard and our update would otherwise keep failing against
  // an id that no longer exists.
  if (req.query.force === '1' && c.agentId) {
    await dataRun('UPDATE companies SET elevenlabs_agent_id = NULL WHERE id = ?', [c.id]);
    invalidateCache(c.id);
    Object.assign(c, { agentId: null });
  }

  // The pipeline owns validation, ordering, per-step reporting and — critically
  // — persisting each provider resource the moment it exists. See
  // services/publish/pipeline.js for why there is no rollback.
  const result = await publishCompany({
    company : c,
    actorEmail: req.user?.email || null,
    log     : req.log,
    deps    : {
      composeSystemPrompt,
      shapeScenario,
      resolveAgentModel,
      isAllowedVoiceId,
      defaultVoiceId  : DEFAULT_VOICE_ID,
      voiceSpeedDefault: VOICE_SPEED_DEFAULT,
      publicBaseUrl   : PUBLIC_BASE_URL,
    },
  });

  invalidateCache(c.id);
  audit(req, result.published ? 'voice.publish' : 'voice.publish.failed', `companies/${c.id}`, {
    agentId: result.agentId, agentIdInbound: result.agentIdInbound, toolId: result.toolId,
    runId: result.runId, failedStep: result.failedStep,
  });

  const body = {
    status      : result.status,
    published   : result.published,
    runId       : result.runId,
    steps       : result.steps,
    failedStep  : result.failedStep,
    agentId     : result.agentId,
    agentIdInbound: result.agentIdInbound,
    toolId      : result.toolId,
    scenarioId  : result.scenarioId,
    scenarioName: result.scenarioName,
    // Publishing changes what the agent SAYS, not which number reaches it.
    // Surface that so the UI can prompt for a bind when the two disagree.
    phoneBound  : result.phoneBound,
  };

  if (result.published) return res.json(body);

  req.log.error('voice publish failed', {
    companyId: c.id, step: result.failedStep, err: result.error,
  });
  // The message names the step, so the existing admin toast becomes actionable
  // without any UI change.
  return res.status(result.httpStatus).json({
    ...body,
    error: `فشل النشر عند «${result.failedStep}»: ${result.error}`,
  });
}

// ─── Company facts (business profile) ────────────────────────────
// The data a caller might ask for: description, working hours, services, rules.
// Client-editable on purpose — unlike `settings`, which gates the daily caps
// and the phone binding as superadmin-only, this is the company's own content.
app.get('/api/companies/:id/business-profile', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ businessProfile: c.businessProfile || {} });
});

app.patch('/api/companies/:id/business-profile', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const parsed = businessProfileSchema.safeParse(req.body?.businessProfile ?? req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error : 'بيانات الشركة غير صالحة.',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })).slice(0, 20),
    });
  }

  await sql.setCompanyBusinessProfile.run({
    id: c.id,
    business_profile: JSON.stringify(parsed.data),
  });
  invalidateCache(c.id);
  audit(req, 'company.business_profile.update', `companies/${c.id}`, {
    fields: Object.keys(parsed.data),
  });

  // Editing facts does NOT change the live agent — publishing does. Say so, so
  // nobody assumes callers already hear the new opening hours.
  const fresh = await loadCompany(c.id);
  res.json({
    businessProfile: fresh.businessProfile,
    factsBlock     : renderFactsBlock(fresh, fresh.businessProfile),
    needsPublish   : true,
  });
});

// ─── Capabilities ────────────────────────────────────────────────
// What this company's agent is allowed to do. Every capability is listed —
// including the ones not built yet — so the UI can distinguish "off" from
// "not available", and `available`/`reason` explain why an enabled capability
// might still not be attached at publish time.
app.get('/api/companies/:id/features', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const s = c.settings || {};
  const ctx = {
    kbChunkCount : Number((await sql.countCompanyChunks.get(c.id))?.n || 0),
    publicBaseUrl: PUBLIC_BASE_URL,
    transferNumber: /^\+[0-9]{8,15}$/.test(String(s.transferPhoneNumber || '').trim())
      ? String(s.transferPhoneNumber).trim() : null,
  };
  res.json({ features: await describeFeatures(c.id, ctx) });
});

app.patch('/api/companies/:id/features/:key', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const enabled = req.body?.enabled === true;
  const r = await setFeature(c.id, req.params.key, enabled, req.body?.config ?? null);
  if (!r.ok) return res.status(r.code === 'UNKNOWN_FEATURE' ? 404 : 400).json(r);

  invalidateCache(c.id);
  audit(req, 'company.feature.update', `companies/${c.id}`, { key: req.params.key, enabled });

  // Turning a capability OFF takes effect immediately — the tool endpoint
  // re-checks on every call. Turning one ON still needs a publish for the
  // agent to gain the tool, so the UI is told which of the two happened.
  res.json({
    ok: true,
    key: req.params.key,
    enabled,
    needsPublish: enabled,
    effectiveImmediately: !enabled,
  });
});

// Render a DRAFT profile without saving it, so the editor can show a live
// preview while the operator types. Deliberately server-side: a preview
// re-implemented in the browser would drift from what publishing actually
// sends, which is the one thing a preview exists to rule out.
app.post('/api/companies/:id/business-profile/preview', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const draft = req.body?.businessProfile ?? req.body ?? {};
  const parsed = businessProfileSchema.safeParse(draft);
  if (!parsed.success) {
    // A draft is allowed to be invalid mid-edit — report the problems and show
    // an empty block rather than failing the request.
    return res.json({
      factsBlock: '',
      hasFacts  : false,
      valid     : false,
      issues    : parsed.error.issues
        .map((i) => ({ path: i.path.join('.'), message: i.message })).slice(0, 20),
    });
  }
  const factsBlock = renderFactsBlock(c, parsed.data);
  res.json({ factsBlock, hasFacts: !!factsBlock, valid: true, issues: [] });
});

// Exactly what a publish would send to the provider, without sending it. This
// is the answer to "show me before you touch the agent": the composed prompt,
// the facts block on its own, and the real agent payload built by the driver.
app.get('/api/companies/:id/publish-preview', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const scenarioRow = await sql.getActiveScenarioForCompany.get(c.id);
  if (!scenarioRow || !scenarioRow.instruction_prompt) {
    return res.status(409).json({
      error: 'فعّل سيناريو أولاً — المعاينة تُبنى من السيناريو النشط.',
      code : 'NO_ACTIVE_SCENARIO',
    });
  }
  const scenario = shapeScenario(scenarioRow);
  const prompt = await composeSystemPrompt(c, scenario.instructionPrompt);
  const factsBlock = renderFactsBlock(c, c.businessProfile);

  const s = c.settings || {};
  const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);
  const { model, temperature, maxTokens } = resolveAgentModel(c);
  const kbChunkCount = Number((await sql.countCompanyChunks.get(c.id))?.n || 0);

  // The genuine payload, built by the SAME function publishing uses — a preview
  // assembled by hand would drift from what is actually sent, which is exactly
  // the kind of divergence a preview is supposed to rule out.
  const agentPayload = voice.DRIVERS.elevenlabs.buildAgentConfig({
    name        : `smart-assistant:${c.id}`,
    prompt,
    firstMessage: scenario.firstMessageInbound || scenario.firstMessage
               || `حياك الله في ${c.name}، كيف يقدر أساعدك؟`,
    language    : c.language,
    model, temperature, maxTokens,
    voiceId        : s.voiceId || DEFAULT_VOICE_ID,
    stability      : clamp(s.stability, 0, 1, 0.8),
    similarityBoost: clamp(s.similarityBoost, 0, 1, 0.8),
    voiceSpeed     : clamp(s.voiceSpeed, 0.7, 1.2, VOICE_SPEED_DEFAULT),
    // Tool ids are resolved at publish time; showing the stored one keeps the
    // preview honest about what is currently attached.
    toolIds        : c.kbToolId ? [c.kbToolId] : [],
    transferNumber : /^\+[0-9]{8,15}$/.test(String(s.transferPhoneNumber || '').trim())
      ? String(s.transferPhoneNumber).trim() : null,
  });

  res.json({
    companyId   : c.id,
    scenarioId  : scenario.id,
    scenarioName: scenario.name,
    prompt,
    promptLength: prompt.length,
    factsBlock,
    hasFacts    : !!factsBlock,
    kbChunks    : kbChunkCount,
    kbCapped    : prompt.length >= KB_INJECT_CAP,
    // The agent payload carries no secrets: the KB tool's company token lives
    // in the separate tool resource, not here.
    agentPayload,
  });
});

// Publish: rebuild this company's voice agent from its ACTIVE SCENARIO.
// `/sync-voice` is kept as an alias so the existing admin UI keeps working; the
// response is a strict superset of what it used to return.
app.post('/api/companies/:id/publish', requireCompanyAccess, handlePublishCompany);
app.post('/api/companies/:id/sync-voice', requireCompanyAccess, handlePublishCompany);

// Bind this company's imported phone number to its agent — i.e. decide which
// agent answers when someone dials the company's 3CX DID.
//
// The number id comes from the company's OWN row and there is deliberately no
// platform-wide fallback: with multiple tenants, a fallback would bind one
// company's line to another company's agent. The DB is only updated after the
// provider confirms, so a failed call leaves no misleading state behind.
// Adopt the agent's CURRENT provider-side configuration as the company's own.
//
// Publishing rebuilds the agent from company settings and therefore replaces
// every field it sends, so anything tuned directly in the provider's dashboard
// is lost on the next publish. That is the correct behaviour -- publish has to
// be authoritative -- but it leaves no way to keep a configuration that was
// arrived at by ear, on real calls, outside this system.
//
// This reads the live agent and writes the handful of values back into the
// company, so the next publish REPRODUCES what is there instead of flattening
// it. It changes nothing on the provider: it is a read plus a local save.
//
// Only the fields publish actually overwrites are adopted. asr.keywords,
// asr.user_input_audio_format and prompt.knowledge_base are deliberately
// absent because publish never sends them and they survive on their own --
// copying them here would imply an ownership this system does not have.
app.post('/api/companies/:id/adopt-agent-settings', requireCompanyAdmin, async (req, res) => {
  const row = await sql.getCompany.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const c = await loadCompany(req.params.id);
  if (!c?.agentId) {
    return res.status(409).json({ error: 'الشركة غير منشورة بعد — لا يوجد وكيل لقراءة إعداداته.', code: 'NOT_PUBLISHED' });
  }

  let agent;
  try {
    agent = await voice.getAgent(c.agentId, c);
  } catch (e) {
    return res.status(502).json({ error: voice.errText(e) });
  }
  if (!agent) return res.status(404).json({ error: 'الوكيل غير موجود لدى المزوّد.', code: 'AGENT_GONE' });

  const cc = agent.conversation_config || {};
  const p  = cc.agent?.prompt || {};
  const adopted = {};
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined);

  if (ALLOWED_MODELS.includes(p.llm)) adopted.model = p.llm;
  if (num(p.temperature, 0, 1) !== undefined) adopted.temperature = Number(p.temperature);
  if (num(p.max_tokens, 50, 800) !== undefined) adopted.maxTokens = Number(p.max_tokens);
  if (ALLOWED_TTS_MODELS.includes(cc.tts?.model_id)) adopted.ttsModel = cc.tts.model_id;
  if (typeof cc.tts?.expressive_mode === 'boolean') adopted.expressiveMode = cc.tts.expressive_mode;
  // A voice the provider holds but our catalogue does not is reported rather
  // than stored: saving it would make every later publish fail with the
  // provider's opaque "Couldn't Find Voice".
  const unknownVoice = cc.tts?.voice_id && !isAllowedVoiceId(cc.tts.voice_id) ? cc.tts.voice_id : null;
  if (cc.tts?.voice_id && !unknownVoice) adopted.voiceId = cc.tts.voice_id;
  if (num(cc.tts?.stability, 0, 1) !== undefined) adopted.stability = Number(cc.tts.stability);
  if (num(cc.tts?.similarity_boost, 0, 1) !== undefined) adopted.similarityBoost = Number(cc.tts.similarity_boost);
  if (num(cc.tts?.speed, 0.7, 1.2) !== undefined) adopted.voiceSpeed = Number(cc.tts.speed);
  if (num(cc.turn?.turn_timeout, 1, 60) !== undefined) adopted.turnTimeoutSeconds = Number(cc.turn.turn_timeout);
  // -1 is the provider's "never end the call on silence" and is a real choice,
  // not a missing value, so it is adopted as-is rather than clamped away.
  if (Number(cc.turn?.silence_end_call_timeout) === -1) adopted.silenceEndCallSeconds = -1;
  else if (num(cc.turn?.silence_end_call_timeout, 5, 300) !== undefined) {
    adopted.silenceEndCallSeconds = Number(cc.turn.silence_end_call_timeout);
  }

  let existing = {};
  try { if (row.settings) existing = JSON.parse(row.settings) || {}; } catch {}
  const changed = Object.keys(adopted).filter((k) => String(existing[k]) !== String(adopted[k]));
  await sql.updateCompanySettings.run({
    id: row.id, settings: JSON.stringify({ ...existing, ...adopted }),
  });
  invalidateCache(row.id);
  audit(req, 'voice.adopt_agent_settings', `companies/${row.id}`, { changed, unknownVoice: unknownVoice || undefined });
  req.log.info('adopted provider agent settings', { companyId: row.id, changed });

  res.json({
    adopted, changed,
    unknownVoice,
    note: unknownVoice
      ? 'الصوت الحالي غير موجود في قائمة الأصوات المعتمدة ولم يُحفظ — أضفه عبر EXTRA_VOICE_IDS أولاً.'
      : null,
  });
});

app.post('/api/companies/:id/bind-phone', requireCompanyAdmin, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!c.agentId) return res.status(400).json({ error: 'انشر الشركة على ElevenLabs أولاً.', code: 'NOT_PUBLISHED' });
  if (!c.phoneNumberId) {
    return res.status(400).json({
      error: 'اضبط معرّف رقم ElevenLabs لهذه الشركة أولاً (حتى لا يُربط رقم شركة أخرى).',
      code : 'NO_PHONE_NUMBER_ID',
    });
  }

  try {
    const { phoneNumberId, agentId } = await voice.bindPhoneNumber(c);
    invalidateCache(c.id);
    audit(req, 'voice.phone_bind', `companies/${c.id}`, { phoneNumberId, agentId });
    res.json({ phoneNumber: c.phoneNumber, phoneNumberId, agentId });
  } catch (e) {
    const detail = voice.errText(e);
    req.log.error('phone bind error', { err: detail, companyId: c.id });
    res.status(e.code === 'NOT_PUBLISHED' || e.code === 'NO_PHONE_NUMBER_ID' ? 400 : 500)
       .json({ error: detail, code: e.code });
  }
});

// Import a company's EXISTING 3CX number into the provider as a SIP-trunk
// number. No number is ever purchased: `phone_number` is the company's own DID
// and the outbound address points back at the customer's own PBX, so the
// number they already advertise keeps working and keeps being theirs.
//
// Superadmin-only — this writes the tenant↔phone-line binding, and the SIP
// credentials it accepts are infrastructure secrets.
app.post('/api/companies/:id/import-phone', requireCompanyAdmin, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const phoneNumber = String(b.phoneNumber || c.phoneNumber || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'رقم الشركة غير صالح. الصيغة: +966XXXXXXXXX' });
  }
  const address = String(b.address || process.env.SIP_TRUNK_ADDRESS || '').trim();
  if (!address) {
    return res.status(400).json({ error: 'عنوان 3CX (address) مطلوب — اسم النطاق أو الـ IP بدون sip:' });
  }
  // A hostname or IP, never a URI. The provider rejects a `sip:` prefix, and
  // catching it here gives a usable message instead of a 422 from upstream.
  if (/^sips?:/i.test(address) || /\s/.test(address)) {
    return res.status(400).json({ error: 'العنوان يجب أن يكون اسم نطاق أو IP فقط (بدون sip:)' });
  }

  const transport = ['tls', 'tcp', 'udp'].includes(String(b.transport || '').toLowerCase())
    ? String(b.transport).toLowerCase() : 'tls';
  const mediaEncryption = ['disabled', 'allowed', 'required'].includes(String(b.mediaEncryption || '').toLowerCase())
    ? String(b.mediaEncryption).toLowerCase() : 'allowed';

  try {
    const { phoneNumberId } = await voice.importPhoneNumber(c, {
      phoneNumber,
      address,
      transport,
      mediaEncryption,
      username: b.username ? String(b.username).slice(0, 128) : null,
      password: b.password ? String(b.password).slice(0, 256) : null,
      allowedAddresses: Array.isArray(b.allowedAddresses)
        ? b.allowedAddresses.map((x) => String(x).slice(0, 64)).slice(0, 20) : [],
    });
    const released = await claimPhoneOwnership({
      companyId: c.id, phoneNumber, phoneNumberId, log: req.log,
    });
    invalidateCache();
    // Credentials are NEVER echoed back or audited — only the resulting id.
    audit(req, 'voice.phone_import', `companies/${c.id}`, {
      phoneNumberId, phoneNumber, transport,
      // Names any company this number was taken from, so a mistaken transfer is
      // visible in the audit log rather than only in the companies table.
      releasedFrom: released.length ? released : undefined,
    });
    res.status(201).json({ phoneNumberId, phoneNumber, releasedFrom: released });
  } catch (e) {
    const detail = voice.errText(e);
    req.log.error('phone import error', { err: detail, companyId: c.id });
    res.status(502).json({ error: detail });
  }
});

// ─── RAG: documents CRUD + retrieval test ────────────────────────
app.post('/api/companies/:id/documents', requireCompanyAccess, upload.single('file'), async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  // Multer stores originalname as latin1 bytes; decode to UTF-8 so Arabic /
  // Unicode filenames display correctly instead of appearing as mojibake.
  const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  try {
    const result = await ingestDocument({
      companyId: c.id,
      filename,
      mime     : req.file.mimetype,
      buffer   : req.file.buffer,
    });
    res.status(201).json({
      documentId  : result.documentId,
      filename,
      chunkCount  : result.chunkCount,
      textLength  : result.textLength,
      sizeBytes   : req.file.size,
      quality     : extractionQuality(result.chunkCount, result.textLength, req.file.size),
    });
  } catch (e) {
    req.log.error('ingest error', { err: e.message, companyId: c.id });
    res.status(400).json({ error: e.message });
  }
});

// Rate how well text was extracted from an uploaded file. A big file that
// yields almost no chunks is almost always image-only (scanned brochure) —
// the agent would then "know" nothing from it. Surfaced in the UI so a
// company fixes it before relying on it.
function extractionQuality(chunkCount, textLength, sizeBytes) {
  if (!chunkCount || textLength < 50) {
    return { level: 'empty', message: 'لم يُستخرج نص من الملف — على الأرجح صور بالكامل. المساعد لن يعرف محتواه. ارفع نسخة نصية.' };
  }
  if (chunkCount <= 2 && sizeBytes > 200 * 1024) {
    return { level: 'low', message: 'استُخرج نص قليل جداً من ملف كبير — غالباً معظمه صور. تحقق أن الأسعار والبيانات مكتوبة كنص.' };
  }
  return { level: 'ok', message: '' };
}

app.get('/api/companies/:id/documents', requireCompanyAccess, async (req, res) => {
  res.json((await sql.listDocuments.all(req.params.id)).map((d) => ({
    ...d,
    quality: extractionQuality(d.chunk_count, (d.chunk_count || 0) * 200, d.size_bytes),
  })));
});

app.delete('/api/companies/:id/documents/:docId', requireCompanyAccess, async (req, res) => {
  const doc = await sql.getDocument.get(req.params.docId);
  if (!doc || doc.company_id !== req.params.id) {
    return res.status(404).json({ error: 'document not found' });
  }
  // Soft-delete the document row (preserves raw_text for forensics) and hard-
  // delete the searchable chunks so retrieval can't surface it any more.
  await withTransaction(async () => {
    await sql.deleteDocument.run(req.params.docId);
    await sql.purgeDocumentChunks.run(req.params.docId);
  });
  invalidateChunkCache(req.params.id);   // deleted chunks must leave the keyword leg
  audit(req, 'document.delete', `companies/${req.params.id}/documents/${req.params.docId}`, { filename: doc.filename });
  res.json({ deleted: 1 });
});

// Download the original document if available, otherwise fallback to extracted text.
app.get('/api/companies/:id/documents/:docId/download', requireCompanyAccess, async (req, res) => {
  const doc = await sql.getDocument.get(req.params.docId);
  if (!doc || doc.company_id !== req.params.id) {
    return res.status(404).json({ error: 'document not found' });
  }

  if (doc.raw_data) {
    const safeName = encodeURIComponent(doc.filename);
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
    return res.send(doc.raw_data);
  }

  // Fallback for old documents that only have raw_text
  const basename = doc.filename.replace(/\.[^.]+$/, '');
  const safeName = encodeURIComponent(basename + '.txt');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
  res.send(doc.raw_text || '');
});

// ─── Dashboard analytics ─────────────────────────────────────────
// Returns aggregated metrics + a 24-hour breakdown for the requested period.
// `period`: today | week | month | quarter | custom. `from`/`to` only used
// for custom. `companyId` optional; without it the stats span all companies.
// The previous period of equal length is returned alongside so the UI can
// show "vs yesterday / vs last week" deltas without a second roundtrip.
function periodRange(period, fromStr, toStr) {
  const now = new Date();
  if (period === 'custom' && fromStr && toStr) {
    return { from: new Date(fromStr), to: new Date(toStr) };
  }
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  if (period === 'week')    from.setDate(from.getDate() - 6);
  if (period === 'month')   from.setDate(from.getDate() - 29);
  if (period === 'quarter') from.setDate(from.getDate() - 89);
  return { from, to };
}
function shiftedPrev({ from, to }) {
  const span = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - span - 1), to: new Date(from.getTime() - 1) };
}
function isoUtc(d) { return d.toISOString().replace('T', ' ').slice(0, 19); }

app.get('/api/dashboard', async (req, res) => {
  const period   = String(req.query.period || 'today');
  const fromStr  = req.query.from || null;
  const toStr    = req.query.to   || null;
  const companyIdRaw = req.query.companyId ? String(req.query.companyId) : null;
  if (companyIdRaw && !COMPANY_ID_RE.test(companyIdRaw)) {
    return res.status(400).json({ error: 'invalid companyId' });
  }
  // Workspace clients are pinned to their own company — they can't peek at
  // platform-wide stats or another company's numbers via the query string.
  let company_id = companyIdRaw;
  if (req.user.role !== 'superadmin') {
    if (!req.user.companyId) return res.status(403).json({ error: 'no company associated' });
    if (company_id && company_id !== req.user.companyId) {
      return res.status(403).json({ error: 'forbidden' });
    }
    company_id = req.user.companyId;
  }

  const cur  = periodRange(period, fromStr, toStr);
  const prev = shiftedPrev(cur);
  const args = (range) => ({ from: isoUtc(range.from), to: isoUtc(range.to), company_id });

  // Stats card metrics for current + previous periods.
  const stat = async (range) => {
    const a = args(range);
    const calls    = (await sql.countCallsInRange.get(a))?.n || 0;
    const avgRow   = await sql.avgCallDurationInRange.get(a);
    const avgDur   = Math.round(avgRow?.avg_dur || 0);
    const okRow    = await sql.callSuccessRateInRange.get(a);
    const ok       = okRow?.ok || 0;
    const total    = okRow?.total || 0;
    const success  = total ? ok / total : 0;
    const chats    = (await sql.countChatSessionsInRange.get(a))?.n || 0;
    return { calls, avgDur, success, chats };
  };
  const current  = await stat(cur);
  const previous = await stat(prev);

  // 24-hour chart for the current period. We bucket on hour-of-day (00..23),
  // not on calendar date — for a "Today" window that maps to a real timeline,
  // for "This Week/Month" it shows when in the day activity tends to land.
  const a = args(cur);
  const callRows = await sql.callsPerHourInRange.all(a);
  const inboundByHour  = new Map();
  const outboundByHour = new Map();
  for (const r of callRows) {
    const map = r.direction === 'outbound' ? outboundByHour : inboundByHour;
    map.set(r.hour, (map.get(r.hour) || 0) + r.n);
  }
  const chatsByHour = new Map((await sql.chatsPerHourInRange.all(a)).map((r) => [r.hour, r.n]));
  const chart = [];
  for (let h = 0; h < 24; h++) {
    const key = String(h).padStart(2, '0');
    chart.push({
      hour    : key,
      inbound : inboundByHour.get(key)  || 0,
      outbound: outboundByHour.get(key) || 0,
      chats   : chatsByHour.get(key)    || 0,
    });
  }

  const scenarios = (await sql.countActiveCompanies.get({ company_id }))?.n || 0;

  res.json({
    period,
    range  : { from: cur.from.toISOString(),  to: cur.to.toISOString()  },
    prev   : { from: prev.from.toISOString(), to: prev.to.toISOString() },
    companyId: company_id,
    current,
    previous,
    scenarios,
    chart,
  });
});

// ─── Conversations (chats + calls unified for the dashboard table) ──────
// Status/outcome/direction columns are *derived* from existing data so the
// frontend table can stay rich without a schema migration:
//   - status   = completed / failed
//   - outcome  = success / not_available  (proxy for "did the AI finish the job")
//   - direction = inbound (everything for now; outbound arrives with batch calls)
app.get('/api/conversations', async (req, res) => {
  const period       = String(req.query.period   || 'all');
  const typeFilter   = String(req.query.type     || 'all');     // all | chat | voice
  const statusFilter = String(req.query.status   || 'all');     // all | completed | failed
  const outcomeFilter= String(req.query.outcome  || 'all');     // all | success | not_available
  const search       = String(req.query.search   || '').trim().toLowerCase();
  const requestedCompany = req.query.companyId ? String(req.query.companyId) : null;
  if (requestedCompany && !COMPANY_ID_RE.test(requestedCompany)) {
    return res.status(400).json({ error: 'invalid companyId' });
  }
  const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));

  // Workspace clients are pinned to their own company.
  let scopedCompany = requestedCompany;
  if (req.user.role !== 'superadmin') {
    if (!req.user.companyId) return res.status(403).json({ error: 'no company associated' });
    if (scopedCompany && scopedCompany !== req.user.companyId) {
      return res.status(403).json({ error: 'forbidden' });
    }
    scopedCompany = req.user.companyId;
  }

  // Resolve target companies.
  const companies = scopedCompany
    ? [await sql.getCompanyIdName.get(scopedCompany)].filter(Boolean)
    : await sql.listCompanyIdNames.all();
  if (!companies.length) return res.json({ items: [], total: 0, page: 1, limit });
  const companyMap = new Map(companies.map((c) => [c.id, c.name]));
  const ids = companies.map((c) => c.id);
  const inPlaceholders = ids.map(() => '?').join(',');

  // Build the time window (default: all time).
  let timeClause = '';
  const timeArgs = [];
  if (period && period !== 'all') {
    const { from, to } = periodRange(period);
    timeClause = ' AND created_at BETWEEN ? AND ?';
    timeArgs.push(isoUtc(from), isoUtc(to));
  }

  // Chats (grouped per session — one row per conversation).
  const chats = typeFilter === 'voice' ? [] : await dataAll(`
    SELECT
      session_id        AS session_id,
      company_id        AS company_id,
      MAX(created_at)   AS ts,
      MAX(user_id)      AS user_id,
      COUNT(*)          AS messages,
      MAX(summary)      AS summary,
      SUM(CASE WHEN assistant_reply IS NULL OR assistant_reply = '' THEN 1 ELSE 0 END) AS missing_replies
    FROM chats
    WHERE company_id IN (${inPlaceholders}) ${timeClause}
    GROUP BY session_id, company_id
  `, [...ids, ...timeArgs]);

  // Calls.
  const calls = typeFilter === 'chat' ? [] : await dataAll(`
    SELECT id, company_id, created_at AS ts, caller_number, duration_sec, ended_reason, summary, direction
    FROM calls
    WHERE company_id IN (${inPlaceholders}) ${timeClause}
  `, [...ids, ...timeArgs]);

  // Hydrate user emails for chat rows in one round-trip.
  const userIds = [...new Set(chats.map((c) => c.user_id).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length) {
    const ph = userIds.map(() => '?').join(',');
    (await dataAll(`SELECT id, email FROM users WHERE id IN (${ph})`, userIds))
      .forEach((u) => userMap.set(u.id, u.email));
  }

  const OK_REASONS = new Set(['customer-ended-call', 'assistant-ended-call']);
  // 60-minute grace window: a row with no ended_reason that was created
  // within the last hour is shown as "in progress" instead of "failed".
  // The user can click into it to trigger an on-demand provider pull which
  // hydrates the row immediately. Past 1h, the row is assumed stale.
  const IN_PROGRESS_CUTOFF = Date.now() - 60 * 60 * 1000;

  const chatItems = chats.map((c) => ({
    id          : `chat-${c.session_id}`,
    sessionId   : c.session_id,
    type        : 'chat',
    direction   : 'inbound',
    timestamp   : c.ts,
    user        : userMap.get(c.user_id) || null,
    phoneNumber : null,
    companyId   : c.company_id,
    companyName : companyMap.get(c.company_id) || c.company_id,
    // Placeholder until the Scenarios feature lands; for now every company has
    // exactly one virtual scenario named after the company itself.
    scenario    : companyMap.get(c.company_id) || c.company_id,
    status      : c.missing_replies === 0 ? 'completed' : 'failed',
    outcome     : (c.messages >= 3 && c.missing_replies === 0) ? 'success' : 'not_available',
    messages    : c.messages,
    duration    : null,
    summary     : c.summary || null,
  }));

  const callItems = calls.map((c) => {
    const ok = OK_REASONS.has(c.ended_reason || '');
    // Three-way status:
    //   completed → call ended with an OK reason
    //   in_progress → no ended_reason yet AND created recently (webhook may
    //                 still arrive, or the call is literally still ringing)
    //   failed → anything else
    let status;
    if (!c.ended_reason) {
      const ts = c.ts ? Date.parse(c.ts + 'Z') : Date.now();
      status = (Number.isFinite(ts) && ts >= IN_PROGRESS_CUTOFF) ? 'in_progress' : 'failed';
    } else {
      status = ok ? 'completed' : 'failed';
    }
    return {
      id          : `call-${c.id}`,
      callId      : c.id,
      type        : 'voice',
      direction   : c.direction || 'inbound',
      timestamp   : c.ts,
      user        : null,
      phoneNumber : decryptField(c.caller_number) || null,
      companyId   : c.company_id,
      companyName : companyMap.get(c.company_id) || c.company_id,
      scenario    : companyMap.get(c.company_id) || c.company_id,
      status,
      outcome     : (ok && (c.duration_sec || 0) >= 30) ? 'success' : 'not_available',
      messages    : null,
      duration    : c.duration_sec || 0,
      endedReason : c.ended_reason || null,
      summary     : c.summary || null,
    };
  });

  let items = [...chatItems, ...callItems];

  // Apply post-aggregation filters (status/outcome/search) — these can't run
  // in SQL because they're derived fields.
  if (statusFilter  !== 'all') items = items.filter((i) => i.status  === statusFilter);
  if (outcomeFilter !== 'all') items = items.filter((i) => i.outcome === outcomeFilter);
  if (search) {
    // Deep content search in SQL (LIKE over transcripts + chat messages) so
    // "the agent said X yesterday" is findable — not just metadata fields.
    const like = `%${search}%`;
    const callHits = new Set(
      (await dataAll(`SELECT id FROM calls WHERE company_id IN (${inPlaceholders}) AND (transcript LIKE ? OR structured_data LIKE ?)`, [...ids, like, like])).map((r) => r.id),
    );
    const chatHits = new Set(
      (await dataAll(`SELECT DISTINCT session_id FROM chats WHERE company_id IN (${inPlaceholders}) AND (user_message LIKE ? OR assistant_reply LIKE ?)`, [...ids, like, like])).map((r) => r.session_id),
    );
    items = items.filter((i) =>
         (i.phoneNumber || '').toLowerCase().includes(search)
      || (i.user        || '').toLowerCase().includes(search)
      || (i.summary     || '').toLowerCase().includes(search)
      || (i.companyName || '').toLowerCase().includes(search)
      || (i.callId && callHits.has(i.callId))
      || (i.sessionId && chatHits.has(i.sessionId))
    );
  }

  items.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const total = items.length;
  const start = (page - 1) * limit;
  const slice = items.slice(start, start + limit);

  res.json({ items: slice, total, page, limit });
});

// ─── CSV export: calls (with lead-qualification columns) ─────────
// UTF-8 BOM so Excel opens Arabic correctly. Sales managers live in Excel;
// this is the cheapest possible CRM bridge.
app.get('/api/companies/:id/calls.csv', requireCompanyAccess, async (req, res) => {
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
  // Sales teams need real numbers to call back, so the export decrypts.
  const rows = decryptRows(await sql.listCallsForCompany.all(req.params.id, limit), CALL_PII_FIELDS);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Arabic headers up front: the operator asked to see "interested or not"
  // when downloading records, so the derived lead qualification + call outcome
  // lead the sheet, followed by the raw extracted fields.
  const header = [
    'call_id', 'direction', 'caller_number', 'started_at', 'duration_sec',
    'تصنيف العميل', 'مهتم؟', 'نتيجة المكالمة',
    'ended_reason', 'interest_level', 'property_type', 'budget',
    'preferred_area', 'callback_requested', 'appointment_requested',
    'summary', 'recording_url',
  ];
  const lines = [header.join(',')];
  // "Interested?" is a plain yes/no rollup of the lead tier, so a manager
  // scanning the column sees intent without reading the classification.
  const INTERESTED = new Set([LEAD.HOT, LEAD.WARM]);
  const NOT_A_LEAD = new Set([LEAD.NO_ANSWER, LEAD.INVALID, LEAD.PENDING]);
  for (const r of rows) {
    let lead = {};
    try { if (r.structured_data) lead = JSON.parse(r.structured_data) || {}; } catch {}
    const q = qualifyCall(r);
    const interested = INTERESTED.has(q.lead) ? 'نعم'
      : NOT_A_LEAD.has(q.lead) ? '—' : 'لا';
    lines.push([
      r.id, r.direction, r.caller_number, r.started_at, r.duration_sec,
      q.leadLabel?.ar || q.lead, interested, q.outcomeLabel?.ar || q.outcome,
      r.ended_reason, lead.interest_level, lead.property_type, lead.budget,
      lead.preferred_area, lead.callback_requested, lead.appointment_requested,
      r.summary, recordingLinkFor(r, PUBLIC_BASE_URL) || '',
    ].map(esc).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  audit(req, 'export.calls_csv', `companies/${req.params.id}`, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="calls-${req.params.id}-${stamp}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
});

// ─── Scenarios: per-company AI agent configurations ─────────────
// Each company can author multiple scenarios (Customer Service / Booking /
// Sales / etc). The chat handler uses the latest *active* scenario for the
// company when generating replies — see companies.buildSystemPromptWithRAG.

// Parse the success criteria stored as JSON in DB into the array shape the
// UI expects; tolerate legacy plain-text rows by treating them as a single
// non-primary criterion.
function parseCriteria(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [{ text: String(raw), primary: false }];
}
function parseVariables(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}
function shapeScenario(row) {
  if (!row) return null;
  return {
    id                  : row.id,
    companyId           : row.company_id,
    name                : row.name,
    description         : row.description || '',
    // Outbound (we call the customer, so we know who's on the line).
    firstMessage        : row.first_message || '',
    // Inbound (customer calls us; identity unknown until later).
    firstMessageInbound : row.first_message_inbound || '',
    instructionPrompt   : row.instruction_prompt || '',
    instructionPromptInbound : row.instruction_prompt_inbound || '',
    successCriteria     : parseCriteria(row.success_criteria),
    variables           : parseVariables(row.variables),
    isActive            : !!row.is_active,
    language            : row.language || 'ar',
    knowledgeBaseIds    : parseVariables(row.knowledge_base_ids),
    createdAt           : row.created_at,
    updatedAt           : row.updated_at,
  };
}

// Auto-detect {{variable}} occurrences and merge with any previously-saved
// configuration (preserving required / type fields).
function detectVariables(prevConfig, ...texts) {
  const prev = new Map((prevConfig || []).map((v) => [v.name, v]));
  const seen = new Set();
  const out  = [];
  const re   = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  const GLOBAL = new Set([
    'agent_name', 'agent_gender', 'date', 'time', 'user_phone_number',
  ]);
  for (const text of texts) {
    if (!text) continue;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const existing = prev.get(name);
      out.push(existing || {
        name,
        type     : GLOBAL.has(name) ? 'global' : 'text',
        required : !GLOBAL.has(name),
      });
    }
  }
  return out;
}

// Single-active invariant: at most one scenario per company carries
// is_active = 1. The activate / create / generate paths all funnel through
// here so we never end up with two "winners" again. Runs as one SQLite
// transaction so a partial failure can't leave the table inconsistent.
const activateExclusively = (companyId, scenarioId) => withTransaction(async () => {
  await sql.deactivateAllScenariosForCompany.run({ company_id: companyId, except_id: scenarioId });
  await sql.setScenarioActive.run({ id: scenarioId, is_active: 1 });
});

// Returns the currently-active scenario for a company (or null). The
// Playground uses this to render input-data fields, prefill the greeting,
// and know whether to surface an "Activate a scenario first" empty state.
app.get('/api/companies/:id/scenarios/active', requireCompanyAccess, async (req, res) => {
  const row = await sql.getActiveScenarioForCompany.get(req.params.id);
  res.json(row ? shapeScenario(row) : null);
});

app.get('/api/companies/:id/scenarios', requireCompanyAccess, async (req, res) => {
  const tab = String(req.query.tab || 'active');
  const rows = tab === 'deleted'
    ? await sql.listDeletedScenarios.all(req.params.id)
    : await sql.listScenarios.all(req.params.id);
  res.json(rows.map((r) => ({
    id              : r.id,
    name            : r.name,
    language        : r.language || 'ar',
    isActive        : !!r.is_active,
    createdAt       : r.created_at,
    updatedAt       : r.updated_at,
    deletedAt       : r.deleted_at || null,
    successCriteria : parseCriteria(r.success_criteria),
  })));
});

app.get('/api/scenarios/:id', requireAuth, async (req, res) => {
  const row = await sql.getScenario.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== row.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json(shapeScenario(row));
});

app.post('/api/companies/:id/scenarios', requireCompanyAccess, validate({ params: schemas.companyIdParam, body: schemas.scenarioCreateBody }), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 200);
  // repairMojibake: if the user pastes text that was saved in a broken
  // encoding (Arabic UTF-8 read as Latin1), fix it on save so the scenario
  // reads correctly — same protection the KB upload has. No-op on clean text.
  const instructionPrompt = repairMojibake(String(b.instructionPrompt || '').trim());
  if (!name || !instructionPrompt) {
    return res.status(400).json({ error: 'name and instructionPrompt are required' });
  }
  const firstMessage        = repairMojibake(String(b.firstMessage || '')).slice(0, 2000);
  const firstMessageInbound = repairMojibake(String(b.firstMessageInbound || '')).slice(0, 2000);
  const criteria     = Array.isArray(b.successCriteria) ? b.successCriteria : [];
  const variables    = detectVariables(b.variables, firstMessage, firstMessageInbound, instructionPrompt);
  const kbIds        = Array.isArray(b.knowledgeBaseIds) ? b.knowledgeBaseIds : [];
  const wantActive = b.isActive !== false;
  const r = await sql.insertScenario.run({
    company_id              : req.params.id,
    name,
    description             : String(b.description || '').slice(0, 4000),
    first_message           : firstMessage,
    first_message_inbound   : firstMessageInbound,
    instruction_prompt      : instructionPrompt.slice(0, 30000),
    success_criteria        : JSON.stringify(criteria),
    variables               : JSON.stringify(variables),
    is_active               : wantActive ? 1 : 0,
    language                : String(b.language || 'ar').slice(0, 8),
    knowledge_base_ids      : JSON.stringify(kbIds),
  });
  if (wantActive) await activateExclusively(req.params.id, r.lastInsertRowid);
  audit(req, 'scenario.create', `scenarios/${r.lastInsertRowid}`, { name });
  res.status(201).json({
    ...shapeScenario(await sql.getScenario.get(r.lastInsertRowid)),
    warnings: lintScenario(instructionPrompt),
  });
});

app.patch('/api/scenarios/:id', requireAuth, async (req, res) => {
  const existing = await sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  const b = req.body || {};

  // Snapshot the CURRENT state before overwriting it, so a bad edit can be
  // rolled back. Only snapshot when the prompt/messages actually change, and
  // keep the last 30 per scenario.
  const contentChanged = (b.instructionPrompt !== undefined && b.instructionPrompt !== existing.instruction_prompt)
    || (b.firstMessage !== undefined && b.firstMessage !== existing.first_message)
    || (b.firstMessageInbound !== undefined && b.firstMessageInbound !== (existing.first_message_inbound || ''));
  if (contentChanged) {
    try {
      await sql.insertScenarioVersion.run({
        scenario_id           : existing.id,
        company_id            : existing.company_id,   // denormalized for RLS
        name                  : existing.name,
        first_message         : existing.first_message,
        first_message_inbound : existing.first_message_inbound || '',
        instruction_prompt    : existing.instruction_prompt,
        edited_by             : req.user?.email || null,
      });
      await sql.pruneScenarioVersions.run(existing.id, existing.id);
    } catch (e) { req.log.error('scenario version snapshot failed', { err: e.message }); }
  }

  // repairMojibake on save — fixes pasted broken-encoding Arabic; no-op on clean text.
  const firstMessage         = b.firstMessage         !== undefined ? repairMojibake(String(b.firstMessage)).slice(0, 2000)         : existing.first_message;
  const firstMessageInbound  = b.firstMessageInbound  !== undefined ? repairMojibake(String(b.firstMessageInbound)).slice(0, 2000)  : (existing.first_message_inbound || '');
  const instructionPrompt    = b.instructionPrompt    !== undefined ? repairMojibake(String(b.instructionPrompt)).slice(0, 30000)   : existing.instruction_prompt;
  const prevVars             = parseVariables(existing.variables);
  const variables            = b.variables !== undefined
    ? (Array.isArray(b.variables) ? b.variables : detectVariables(prevVars, firstMessage, firstMessageInbound, instructionPrompt))
    : detectVariables(prevVars, firstMessage, firstMessageInbound, instructionPrompt);
  const nextIsActive = b.isActive !== undefined ? (b.isActive ? 1 : 0) : existing.is_active;
  await sql.updateScenario.run({
    id                       : existing.id,
    name                     : b.name             !== undefined ? String(b.name).trim().slice(0, 200) : existing.name,
    description              : b.description      !== undefined ? String(b.description).slice(0, 4000) : (existing.description || ''),
    first_message            : firstMessage,
    first_message_inbound    : firstMessageInbound,
    instruction_prompt       : instructionPrompt,
    success_criteria         : b.successCriteria !== undefined ? JSON.stringify(b.successCriteria) : (existing.success_criteria || '[]'),
    variables                : JSON.stringify(variables),
    is_active                : nextIsActive,
    language                 : b.language         !== undefined ? String(b.language).slice(0, 8) : (existing.language || 'ar'),
    knowledge_base_ids       : b.knowledgeBaseIds !== undefined
      ? JSON.stringify(b.knowledgeBaseIds)
      : (existing.knowledge_base_ids || '[]'),
  });
  // If this PATCH flipped isActive ON, deactivate the other scenarios so we
  // still satisfy the one-active-per-company invariant.
  if (nextIsActive === 1) await activateExclusively(existing.company_id, existing.id);
  // Optional inbound prompt (Phase 3) — saved separately so the core update
  // statement + its other call-sites stay untouched.
  if (b.instructionPromptInbound !== undefined) {
    await sql.setScenarioInboundPrompt.run({ id: existing.id, v: repairMojibake(String(b.instructionPromptInbound)).slice(0, 30000) });
  }
  audit(req, 'scenario.update', `scenarios/${existing.id}`, Object.keys(b));
  res.json({
    ...shapeScenario(await sql.getScenario.get(existing.id)),
    warnings: lintScenario(instructionPrompt),
  });
});

// Version history for a scenario (last 30 edits).
async function ensureScenarioAccess(req, res) {
  const row = await sql.getScenario.get(req.params.id);
  if (!row) { res.status(404).json({ error: 'not found' }); return null; }
  if (req.user.role !== 'superadmin' && req.user.companyId !== row.company_id) {
    res.status(404).json({ error: 'not found' }); return null;
  }
  return row;
}

app.get('/api/scenarios/:id/versions', requireAuth, async (req, res) => {
  if (!await ensureScenarioAccess(req, res)) return;
  res.json(await sql.listScenarioVersions.all(req.params.id));
});

// Roll back a scenario to a previous version. Snapshots the current state
// first (so rollback is itself undoable), then restores the chosen version.
app.post('/api/scenarios/:id/rollback/:versionId', requireAuth, async (req, res) => {
  const existing = await ensureScenarioAccess(req, res);
  if (!existing) return;
  const version = await sql.getScenarioVersion.get(req.params.versionId);
  if (!version || version.scenario_id !== existing.id) {
    return res.status(404).json({ error: 'version not found' });
  }
  try {
    await sql.insertScenarioVersion.run({
      scenario_id           : existing.id,
      company_id            : existing.company_id,     // denormalized for RLS
      name                  : existing.name,
      first_message         : existing.first_message,
      first_message_inbound : existing.first_message_inbound || '',
      instruction_prompt    : existing.instruction_prompt,
      edited_by             : req.user?.email || null,
    });
  } catch {}
  const variables = detectVariables(
    parseVariables(existing.variables),
    version.first_message, version.first_message_inbound, version.instruction_prompt,
  );
  await sql.updateScenario.run({
    id                    : existing.id,
    name                  : version.name || existing.name,
    description           : existing.description || '',
    first_message         : version.first_message || '',
    first_message_inbound : version.first_message_inbound || '',
    instruction_prompt    : version.instruction_prompt || '',
    success_criteria      : existing.success_criteria || '[]',
    variables             : JSON.stringify(variables),
    is_active             : existing.is_active,
    language              : existing.language || 'ar',
    knowledge_base_ids    : existing.knowledge_base_ids || '[]',
  });
  await sql.pruneScenarioVersions.run(existing.id, existing.id);
  audit(req, 'scenario.rollback', `scenarios/${existing.id}`, { versionId: version.id });
  res.json(shapeScenario(await sql.getScenario.get(existing.id)));
});

// Live lint — the editor calls this (debounced) so a company sees TTS/prompt
// problems as it types, before saving or publishing. Stateless + auth-gated.
app.post('/api/scenarios/lint', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 30000);
  res.json({ warnings: lintScenario(text) });
});

// Vetted, lint-clean starting templates a company can build from.
app.get('/api/scenario-templates', requireAuth, async (_req, res) => {
  res.json(SCENARIO_TEMPLATES);
});

// Test a DRAFT scenario before publishing — runs the unsaved prompt text
// (composed exactly like a real call: + KB + endCall rule) through the model
// and returns the reply. Lets a company verify behaviour before pressing نشر.
app.post('/api/companies/:id/scenarios/test-draft', chatLimiter, requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const draft   = String(req.body?.instructionPrompt || '').slice(0, 30000);
  const message = String(req.body?.message || '').trim();
  if (!draft.trim()) return res.status(400).json({ error: 'اكتب نص السيناريو أولاً' });
  if (!message)      return res.status(400).json({ error: 'message required' });
  if (message.length > MAX_USER_MSG_CHARS) return res.status(413).json({ error: 'message too long' });

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .slice(-MAX_HISTORY)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));

  const systemContent = await composeSystemPrompt(c, draft);
  try {
    const t0 = Date.now();
    // The whole point of the draft tester is to preview what will ship, so it
    // must run the company's OWN model/temperature — not a cheaper stand-in.
    const m = resolveAgentModel(c);
    const completion = await openai.chat.completions.create({
      model: m.model, temperature: m.temperature, max_tokens: m.maxTokens,
      messages: [{ role: 'system', content: systemContent }, ...history, { role: 'user', content: message }],
    });
    res.json({ reply: completion.choices[0].message.content, ms: Date.now() - t0, model: m.model });
  } catch (e) {
    req.log.error('test-draft error', { err: e.message, companyId: c.id });
    res.status(502).json({ error: 'تعذّر تشغيل الاختبار. حاول مرة ثانية.' });
  }
});

// Preview the EXACT system prompt the assistant will run on — scenario text +
// KB dump (capped) + end-call wiring — so a company can see what the provider
// receives (eliminates the "hidden layers" confusion). Pass ?draft=... to
// preview unsaved text, otherwise uses the active scenario.
app.post('/api/companies/:id/scenarios/preview-prompt', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  let prompt = req.body?.instructionPrompt;
  if (prompt === undefined) {
    const row = await sql.getActiveScenarioForCompany.get(c.id);
    prompt = row?.instruction_prompt || '';
  }
  const composed = await composeSystemPrompt(c, String(prompt).slice(0, 30000));
  const chunks = await sql.listAllChunksForCompany.all(c.id);
  res.json({
    prompt    : composed,
    length    : composed.length,
    kbChunks  : chunks.length,
    kbCapped  : composed.length >= KB_INJECT_CAP, // KB likely truncated
    capChars  : KB_INJECT_CAP,
  });
});

app.post('/api/scenarios/:id/activate', requireAuth, async (req, res) => {
  const existing = await sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  const isActive = req.body?.isActive === false ? 0 : 1;
  if (isActive) {
    // Activating: this scenario becomes the sole active one for the company.
    await activateExclusively(existing.company_id, existing.id);
  } else {
    await sql.setScenarioActive.run({ id: existing.id, is_active: 0 });
  }
  audit(req, isActive ? 'scenario.activate' : 'scenario.deactivate', `scenarios/${existing.id}`);
  res.json({ id: existing.id, isActive: !!isActive });
});

app.delete('/api/scenarios/:id', requireAuth, async (req, res) => {
  const existing = await sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  await sql.softDeleteScenario.run(existing.id);
  audit(req, 'scenario.delete', `scenarios/${existing.id}`, { name: existing.name });
  res.json({ deleted: true });
});

// AI-assisted scenario generation. The user describes the agent in plain
// language; gpt-4o-mini returns a fully-fleshed scenario as strict JSON
// which the frontend then routes to the edit page for review.
const SCENARIO_GEN_SYSTEM = `أنت مهندس سيناريوهات لمنصة Voice AI تخدم السوق السعودي. مهمتك إنّك تاخد وصف مختصر للوكيل اللي العميل عاوزه، وتولّد سيناريو كامل جاهز للاستخدام.

السيناريو لازم يحتوي على:
1. اسم واضح ومهني للسيناريو بالإنجليزية (مثل "Telecom Customer Service")
2. رسالتين افتتاحيتين بالعربية بصيغتين منفصلتين:
   (a) first_message — للمكالمات الصادرة (outbound). نعرف اسم العميل، استخدم {{customer_name}}:
       "مرحباً {{customer_name}}، معك {{agent_name}} من <اسم الشركة الحقيقي>، كيف يقدر أساعدك اليوم؟"
   (b) first_message_inbound — للمكالمات الواردة (inbound). ما نعرف اسم العميل، استخدم تحية عامة:
       "حياك الله في <اسم الشركة الحقيقي>، معك {{agent_name}}، كيف يقدر أساعدك اليوم؟"
   - {{agent_name}} في الاتنين = اسم بشري للوكيل (هيتعبّى تلقائياً باسم الصوت المختار).
   - اسم الشركة اكتبه صريح كما هو (مثلاً: "وكن العقارية") — مش متغير.
   - متخليش الـ agent يقول "أنا [اسم الشركة]" — هو شخص يعمل في الشركة، مش الشركة نفسها.
3. instruction prompt تفصيلي بالعربية يحتوي على الأقسام التالية بالترتيب:
   - AGENT IDENTITY & PURPOSE — مين هو، ويشتغل عند مين، وإيش هدفه من المكالمة
   - TONE & STYLE (Saudi Najdi Arabic dialect, lahjet اللهجة السعودية)
     لازم يتضمن قاعدة الاختصار: الوكيل على تلفون مش في شات. جمل قصيرة،
     جملة أو جملتين في الرد الواحد، بدون مقدمات ولا تلخيص لكلام العميل.
     الإطالة في الصوت تخلي العميل يقاطع أو يقفل.
   - CONVERSATION FLOW (خطوات الحوار بالترتيب، مرقّمة)
   - INFORMATION TO COLLECT — إيش البيانات المطلوبة بالضبط
   - DATA CAPTURE PROTOCOL — إزاي يتأكد من كل بيانات يجمعها. هذا القسم إجباري
     وما ينفع يكون عام. لازم يحدد:
       · بعد كل رقم جوال أو رقم حساب: يعيده على العميل رقماً رقماً بالكلمات
         (مثال: خمسة، صفر، خمسة…) ويسأل "صح كذا؟" قبل ما يكمل
       · بعد الاسم: يعيده كما سمعه ويسأل عن التأكيد
       · إذا ما سمع بوضوح: يطلب الإعادة مرة وحدة بأدب، ما يخمّن أبداً
     تأكيد البيانات صوتياً هو أكثر مكان تفشل فيه الوكلاء الصوتية، فخلّي
     التعليمات هنا محددة وقابلة للتنفيذ حرفياً.
   - KNOWLEDGE BOUNDARIES — قاعدة صريحة ضد اختلاق المعلومات:
     "جاوب من قاعدة المعرفة والتعليمات فقط. إذا كانت المعلومة غير موجودة في
     أي منهما، قل بوضوح ومهنية إنك ما تعرف وإنك تحوّل العميل لموظف — ولا
     تخمّن ولا تخترع سعر ولا موعد ولا توفّر."
     بدون هذه الجملة، النموذج يخترع إجابات لما ما يلاقي المعلومة.
   - ESCALATION & TRANSFER RULES
   - END CALL CONDITIONS
   - SAFETY & PRIVACY (مش يكشف معلومات داخلية، مش يخترع حقائق)

   قواعد كتابة إجبارية داخل الـ instruction prompt:
   - بدون تشكيل (حركات) نهائياً — التشكيل يخلي المحرك الصوتي ينطق غلط
   - الأرقام تُكتب بالكلمات مش بالخانات (مئتين وعشرين، مش ٢٢٠)
   - بدون كلمات إنجليزية داخل النص المنطوق (عناوين الأقسام بالإنجليزي عادي،
     لأنها تعليمات للنموذج ومش بتتقال للعميل)
4. ثلاث معايير نجاح بالعربية، كل معيار جملة واحدة واضحة وقابلة للقياس

أخرج JSON صالح فقط، بدون أي شرح خارج JSON، بهذا الشكل بالظبط:
{
  "name": "...",
  "first_message": "...",
  "first_message_inbound": "...",
  "instruction_prompt": "...",
  "success_criteria": ["...", "...", "..."]
}`;

app.post('/api/companies/:id/scenarios/generate', requireCompanyAccess, async (req, res) => {
  const description = String(req.body?.description || '').trim();
  if (description.length < 20) {
    return res.status(400).json({ error: 'description must be at least 20 characters' });
  }
  if (description.length > 10000) {
    return res.status(400).json({ error: 'description too long' });
  }
  const language = String(req.body?.language || 'ar').slice(0, 8);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SCENARIO_GEN_SYSTEM },
        { role: 'user',   content: description },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (e) {
      req.log.error('scenario gen: invalid JSON', { raw: raw.slice(0, 400) });
      return res.status(502).json({ error: 'AI returned invalid JSON; try again or rephrase' });
    }
    const name                  = String(parsed.name                  || 'Generated Scenario').slice(0, 200);
    const firstMessage          = String(parsed.first_message          || '').slice(0, 2000);
    const firstMessageInbound   = String(parsed.first_message_inbound  || '').slice(0, 2000);
    const instructionPrompt     = String(parsed.instruction_prompt     || '').slice(0, 30000);
    const criteriaArr           = Array.isArray(parsed.success_criteria) ? parsed.success_criteria : [];
    const successCriteria       = criteriaArr.slice(0, 6).map((t, i) => ({
      text: String(t).slice(0, 500),
      primary: i === 0,
    }));
    const variables = detectVariables([], firstMessage, firstMessageInbound, instructionPrompt);

    const r = await sql.insertScenario.run({
      company_id              : req.params.id,
      name,
      description,
      first_message           : firstMessage,
      first_message_inbound   : firstMessageInbound,
      instruction_prompt      : instructionPrompt,
      success_criteria        : JSON.stringify(successCriteria),
      variables               : JSON.stringify(variables),
      is_active          : 1,
      language,
      knowledge_base_ids : '[]',
    });
    // AI-generated scenarios are immediately the new active one for the
    // company, so deactivate any sibling that was previously winning.
    await activateExclusively(req.params.id, r.lastInsertRowid);
    audit(req, 'scenario.generate', `scenarios/${r.lastInsertRowid}`, { name });
    res.status(201).json(shapeScenario(await sql.getScenario.get(r.lastInsertRowid)));
  } catch (e) {
    const hasKey = !!process.env.OPENAI_API_KEY;
    req.log.error('scenario gen error', {
      err    : e.message,
      status : e.status,
      type   : e.constructor?.name,
      hasKey,
    });
    let msg = e.message || 'AI generation failed';
    if (!hasKey) {
      msg = 'OPENAI_API_KEY مش موجود على الخادم — أضفه في Railway Variables وأعد النشر.';
    } else if (e.status === 401) {
      msg = 'OPENAI_API_KEY غير صالح. تحقق من القيمة في Railway Variables.';
    } else if (e.status === 429) {
      msg = 'تم تجاوز الحصة أو معدّل الطلبات من OpenAI. تحقق من رصيد الحساب.';
    } else if (/connection error/i.test(e.message || '') || e.constructor?.name === 'APIConnectionError') {
      msg = 'تعذّر الاتصال بـ OpenAI من الخادم. تحقق من اتصال Railway بالإنترنت ومن صحة المفتاح.';
    } else if (e.constructor?.name === 'APITimeoutError') {
      msg = 'طلب OpenAI تأخر. حاول مرة ثانية أو قلّل وصف السيناريو.';
    }
    res.status(502).json({ error: msg });
  }
});

app.post('/api/companies/:id/rag-test', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const query = (req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const chunks = await retrieve(c.id, query, { topK: 6, minScore: 0.0 });
    res.json({
      query,
      chunks: chunks.map((ch) => ({
        id        : ch.id,
        documentId: ch.documentId,
        score     : Number((ch.score || 0).toFixed(4)),
        kwScore   : Number((ch.kwScore || 0).toFixed(2)),
        preview   : ch.text.slice(0, 280) + (ch.text.length > 280 ? '...' : ''),
        text      : ch.text,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Last-resort error handler: anything a route threw (or passed to next())
// that nothing else handled. Without this, Express prints an HTML stack
// trace — leaking internals and bypassing our logging/Sentry entirely.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const isClientErr = err instanceof multer.MulterError || err.status === 400 || err.type === 'entity.too.large';
  const status = err.status || (isClientErr ? 400 : 500);
  (req.log || logger).error('unhandled route error', { err: err.message, path: req.path, status });
  metrics.recordAppError();
  if (status >= 500) captureError(err, { path: req.path, requestId: req.id });
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
});

const PORT = process.env.PORT || 3000;
let httpServer = null;
// Fail-safe secret validation: in production, refuse to boot if a required
// provider/security secret is missing or malformed (Task #4).
enforceSecretsAtBoot();
initDb().then(() => {
  httpServer = app.listen(PORT, () => {
    logger.info('server started', { port: Number(PORT), driver: isPg ? 'postgres' : 'sqlite', adminUrl: `http://localhost:${PORT}/admin/` });
  });
}).catch((e) => {
  logger.error('db init failed — exiting', { err: e.message });
  process.exit(1);
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, checkpoint the SQLite WAL, and exit cleanly. Falls back to a hard
// exit after 25s so a misbehaving stream doesn't pin the process.
function shutdown(signal) {
  logger.info('shutdown initiated', { signal });
  const force = setTimeout(() => {
    logger.error('force exit after 25s timeout');
    process.exit(1);
  }, 25000);
  force.unref();
  // Drain background workers (finishes the active job) before the DB closes.
  Promise.resolve(queueShutdown()).catch((e) => logger.error('queue shutdown error', { err: e.message }));
  if (!httpServer) { process.exit(0); }
  httpServer.close((err) => {
    if (err) logger.error('http close error', { err: err.message });
    if (!isPg) {
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { logger.error('wal checkpoint failed', { err: e.message }); }
    }
    Promise.resolve(dbClose()).catch(() => {}).then(() => {
      clearTimeout(force);
      process.exit(0);
    });
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
