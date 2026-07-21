require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const axios   = require('axios');
const OpenAI  = require('openai');
const helmet  = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const multer = require('multer');
const { db, sql, get: dataGet, all: dataAll, run: dataRun, withTransaction, initDb, healthCheck, close: dbClose, isPg } = require('./db');
// TEXT timestamp literal for dynamic SQL that must run on both engines.
const NOW_SQL = isPg ? `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')` : `datetime('now')`;
const { loadCompany, listCompaniesFull, invalidateCache, buildSystemPromptWithRAG, fillGlobals } = require('./companies');
const { summarize, chatToTranscript } = require('./summarize');
const { ingestDocument, retrieve, repairMojibake, invalidateChunkCache } = require('./lib/rag');
const { END_CALL_TOOL_RULE } = require('./lib/master-prompt');
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
const { upsertVapiCall, startDrainTimer } = require('./services/call-events');
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
// pin a request indefinitely. OpenAI is the most variable; ElevenLabs starts
// streaming fast but the connection establishment may stall; Vapi sync is
// occasional and slow.
const OPENAI_TIMEOUT_MS = 25_000;
const VAPI_TIMEOUT_MS   = 20_000;

// Numeric env override with a safe fallback — used by the latency-tuning knobs
// below so they can be A/B'd from Railway without a code change.
const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

// Speech-to-text provider. Default is the Arabic-pinned Gemini the operator
// selected for accuracy. Profiling 145 real turns showed it is also the single
// largest latency source (see the comment at the transcriber assignment), so
// it is env-overridable to allow a like-for-like A/B against Vapi's own
// performanceMetrics. Set TRANSCRIBER_JSON to a full Vapi transcriber object.
const TRANSCRIBER = (() => {
  const raw = (process.env.TRANSCRIBER_JSON || '').trim();
  if (!raw) return { provider: 'google', model: 'gemini-2.5-flash', language: 'Arabic' };
  try {
    const t = JSON.parse(raw);
    if (t && typeof t === 'object' && t.provider) return t;
    console.warn('TRANSCRIBER_JSON missing "provider" — using the default transcriber');
  } catch (e) {
    console.warn(`TRANSCRIBER_JSON is not valid JSON (${e.message}) — using the default transcriber`);
  }
  return { provider: 'google', model: 'gemini-2.5-flash', language: 'Arabic' };
})();

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

// Public base URL of THIS server (no trailing slash). Needed when we hand
// Vapi a callback URL (the in-call KB search tool). Railway exposes the
// public domain as RAILWAY_PUBLIC_DOMAIN; PUBLIC_BASE_URL env overrides.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/+$/, '');
const TRUST_PROXY = Number.isFinite(Number(process.env.TRUST_PROXY))
  ? Number(process.env.TRUST_PROXY)
  : (ON_RAILWAY ? 1 : 0);
app.set('trust proxy', TRUST_PROXY);

// Strict CSP for the SPA. `unsafe-inline` on style is required by Tailwind's
// runtime styles + lucide-react inline SVG styling. All script must be served
// from same origin (no inline JS, no eval). `connect-src` covers fetch/XHR;
// the Vapi Web SDK calls api.vapi.ai (REST), wss://*.vapi.ai (signaling),
// and *.daily.co (WebRTC media servers Vapi uses under the hood).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:     ["'self'"],
      // Daily.co's WebRTC bundle (Vapi loads it dynamically) is evaluated via
      // `eval` of a remote script. We have to allow both 'unsafe-eval' and
      // c.daily.co in script-src for the SDK to start a call.
      scriptSrc:      ["'self'", "'unsafe-eval'", 'https://*.daily.co'],
      scriptSrcAttr:  ["'none'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc:         ["'self'", "data:", "blob:"],
      fontSrc:        ["'self'", "data:", 'https://fonts.gstatic.com'],
      // Vapi SDK's own error telemetry routes through sentry.io.
      connectSrc:     [
        "'self'",
        'https://api.vapi.ai', 'https://*.vapi.ai',
        'wss://api.vapi.ai',   'wss://*.vapi.ai',
        'https://*.daily.co',  'wss://*.daily.co',
        'https://*.ingest.sentry.io',
      ],
      mediaSrc:       ["'self'", "blob:", 'https://*.vapi.ai', 'https://*.daily.co'],
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

// Raw body capture for Vapi webhook HMAC verification.
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
// Skip for safe methods and for the Vapi webhook (server-to-server, HMAC-signed).
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
// External integrations POST a customer message here and get the AI agent's
// text reply. Calls Vapi /chat with previousChatId resumed from the
// whatsapp_sessions table (keyed by customer phone) so a returning customer
// continues the same conversation. Server-to-server; mounted before
// requireAuth so callers don't need a logged-in session.
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
  if (!company.assistantId) {
    return res.status(409).json({ success: false, error: 'company not published to Vapi' });
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

  // Resume previousChatId for this (company, customer_phone) pair so the
  // conversation stays stateful across multiple HTTP calls.
  const prev = await sql.getWhatsappSession.get(company.id, customerPhone);
  const previousChatId = prev?.vapi_chat_id || undefined;

  const t0 = Date.now();
  const vapiHeaders = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' };
  const vapiBody = (withPrev) => ({
    assistantId       : company.assistantId,
    input             : message,
    assistantOverrides: { variableValues: vars },
    ...(withPrev && previousChatId ? { previousChatId } : {}),
  });

  let reply = '';
  let newChatId = previousChatId;
  try {
    const r = await axios.post('https://api.vapi.ai/chat', vapiBody(true),
      { headers: vapiHeaders, timeout: VAPI_TIMEOUT_MS });
    reply = (r.data.output || []).map((x) => x.content).filter(Boolean).join('\n').trim();
    newChatId = r.data.id || newChatId;
  } catch (e) {
    // Stale chat ids expire on Vapi — retry once without previousChatId.
    if (previousChatId && /not found|invalid/i.test(e.response?.data?.message || '')) {
      try {
        const r = await axios.post('https://api.vapi.ai/chat', vapiBody(false),
          { headers: vapiHeaders, timeout: VAPI_TIMEOUT_MS });
        reply = (r.data.output || []).map((x) => x.content).filter(Boolean).join('\n').trim();
        newChatId = r.data.id;
      } catch (e2) {
        req.log.error('agent api: vapi chat (retry) failed', { err: e2.message, companyId: company.id });
        return res.status(502).json({ success: false, error: 'agent unavailable' });
      }
    } else {
      req.log.error('agent api: vapi chat failed', { err: e.message, status: e.response?.status, companyId: company.id });
      return res.status(502).json({ success: false, error: 'agent unavailable' });
    }
  }

  // Persist the new chat id so the next inbound message resumes the thread.
  await sql.upsertWhatsappSession.run({
    company_id    : company.id,
    customer_phone: customerPhone,
    vapi_chat_id  : newChatId || null,
  });

  // Log to chats so the conversation shows up in the dashboard.
  try {
    await sql.insertChat.run({
      company_id     : company.id,
      session_id     : 'api-' + customerPhone.replace(/[^0-9]/g, ''),
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
    chat_id    : newChatId || null,
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
// technical endCall wiring. Single source of truth shared by syncVapi (voice),
// the draft tester, and the prompt preview — so what you test == what ships.
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
const ALLOWED_MODELS = ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini'];
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

// Create-or-update a Vapi assistant from a config. Verifies a stored id still
// exists (clears if 404), recovers by name, then PATCH/POST. Returns the id.
// Shared by the primary and the optional inbound assistant.
async function upsertVapiAssistant(cfg, existingId, vapiOpts, log) {
  let id = existingId;
  if (id) {
    try {
      await axios.get(`https://api.vapi.ai/assistant/${id}`, vapiOpts);
    } catch (e) {
      if (e.response?.status === 404) { log?.warn?.('vapi: stored assistant gone, recreating', { id }); id = null; }
      else throw e;
    }
  }
  if (!id) {
    const list = (await axios.get('https://api.vapi.ai/assistant', vapiOpts)).data || [];
    id = list.find((a) => a.name === cfg.name)?.id || null;
  }
  if (id) await axios.patch(`https://api.vapi.ai/assistant/${id}`, cfg, vapiOpts);
  else { const r = await axios.post('https://api.vapi.ai/assistant', cfg, vapiOpts); id = r.data.id; }
  return id;
}

function getOrMakeSessionId(req) {
  return req.body?.sessionId || req.headers['x-session-id'] || crypto.randomUUID();
}

// ─── Public routes ───────────────────────────────────────────────
app.get('/', (_req, res) => res.redirect('/admin/'));

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

// Voice pacing defaults applied at every Vapi sync (env-tunable, no deploy):
//   speed 1.2 (faster speech) + optimizeStreamingLatency 4 (fastest streaming),
//   both per the operator's request. Clamped to ElevenLabs' valid ranges.
const VOICE_SPEED_DEFAULT   = clampRange(process.env.VOICE_SPEED_DEFAULT, 0.7, 1.2, 1.2);
const VOICE_LATENCY_DEFAULT = clampRange(process.env.VOICE_LATENCY_DEFAULT, 0, 4, 4);
function clampRange(v, lo, hi, dflt) {
  return Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt;
}

const PLAYGROUND_VOICES = [
  { id: 'MI88rOZjXbH22N8KHXUo', name: 'Ali', label: 'علي', description: 'صوت هادئ وواضح', gender: 'male', accent: 'arabic' },
  { id: 'cFUFIbKkO2iZFwS8cRnY', name: 'Nasser', label: 'ناصر', description: 'صوت سعودي طبيعي', gender: 'male', accent: 'saudi' },
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

// Outbound call: Vapi rings the user's phone using the company's synced
// assistant. No WebRTC needed in the browser — Vapi handles the full PSTN
// pipeline. Same assistant as a real customer call → same prompt, same voice,
// same transcriber, real production behaviour.
app.post('/api/companies/:id/outbound-call', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'company not found' });
  if (!c.assistantId) {
    return res.status(409).json({ error: 'انشر الشركة على Vapi أولاً.', code: 'NOT_PUBLISHED' });
  }
  // Per-company outbound number lets each company call from its OWN number.
  // Falls back to the platform-wide env var for single-tenant setups.
  const outboundPhoneId = c.settings?.outboundPhoneNumberId || process.env.VAPI_PHONE_NUMBER_ID;
  if (!outboundPhoneId) {
    return res.status(503).json({ error: 'رقم صادر غير مضبوط لهذه الشركة (إعدادات الصوت) ولا VAPI_PHONE_NUMBER_ID.' });
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

  // Outbound override: use the scenario's outbound first_message instead of
  // the inbound default baked into the assistant. Vapi interpolates
  // {{customer_name}}/etc from variableValues at call start.
  const overrides = { variableValues: vars };
  const activeScenario = await sql.getActiveScenarioForCompany.get(c.id);
  if (activeScenario?.first_message) {
    overrides.firstMessage = activeScenario.first_message;
  }
  // assistant-speaks-first: greet immediately when the callee picks up, then
  // continue. Delivering the FULL opening from its start (with no clipping)
  // depends on the carrier/3CX sending the SIP answer (200 OK) only when the
  // callee actually picks up — otherwise the assistant speaks during ringing.
  overrides.firstMessageMode = 'assistant-speaks-first';

  try {
    const r = await axios.post(
      'https://api.vapi.ai/call',
      {
        assistantId       : c.assistantId,
        phoneNumberId     : outboundPhoneId,
        customer          : { number: phoneNumber },
        assistantOverrides: overrides,
      },
      {
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: VAPI_TIMEOUT_MS,
      },
    );
    // Pre-register the call so it appears in Conversations immediately,
    // even before Vapi's end-of-call-report webhook arrives. The webhook's
    // upsert fills in transcript/duration/cost when the call ends.
    try {
      await sql.insertOutboundCallStub.run({
        id            : r.data.id,
        company_id    : c.id,
        assistant_id  : c.assistantId,
        caller_number : encryptField(phoneNumber),
      });
    } catch (e) {
      req.log.error('outbound-call stub insert failed', { err: e.message });
    }
    audit(req, 'playground.outbound', `calls/${r.data.id}`, { phoneNumber, companyId: c.id });
    res.json({ callId: r.data.id, status: r.data.status });
  } catch (e) {
    const detail = e.response?.data?.message || e.response?.data?.error || e.message;
    req.log.error('outbound-call error', { err: detail, companyId: c.id });
    res.status(502).json({ error: String(detail).slice(0, 300) });
  }
});

// Text chat with the same Vapi assistant (no audio). Useful when the user
// wants to test the scenario without a phone call. Vapi's /chat endpoint
// runs the EXACT same prompt + variables but skips STT/TTS entirely.
app.post('/api/companies/:id/assistant-chat', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'company not found' });
  if (!c.assistantId) {
    return res.status(409).json({ error: 'انشر الشركة على Vapi أولاً.', code: 'NOT_PUBLISHED' });
  }
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  if (message.length > MAX_USER_MSG_CHARS) return res.status(413).json({ error: 'message too long' });
  const previousChatId = String(req.body?.previousChatId || '').slice(0, 80) || undefined;
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
    const r = await axios.post(
      'https://api.vapi.ai/chat',
      {
        assistantId       : c.assistantId,
        input             : message,
        previousChatId,
        assistantOverrides: { variableValues: vars },
      },
      {
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: VAPI_TIMEOUT_MS,
      },
    );
    // Vapi returns output as an array of message objects.
    const reply = (r.data.output || []).map((m) => m.content).filter(Boolean).join('\n').trim();
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
    res.json({ chatId: r.data.id, reply, sessionId });
  } catch (e) {
    const detail = e.response?.data?.message || e.response?.data?.error || e.message;
    req.log.error('assistant-chat error', { err: detail, companyId: c.id });
    res.status(502).json({ error: String(detail).slice(0, 300) });
  }
});

// /chat-voice, /stt, /tts were the old browser-only voice pipeline. Vapi
// Web SDK now handles audio in the Playground, so these routes are gone.
// The /chat (text) endpoint above stays for non-voice scenarios + tests.

// The Vapi webhook pipeline lives in routes/webhook.js (verification +
// inbox) and services/call-events.js (event -> calls row + drain).
app.use('/webhook', webhookRoutes);
startDrainTimer();
startCampaignWorker();
// PDPL retention. No-op unless RETENTION_DAYS_* is configured (audit F-04a).
startRetentionWorker();

// ─── Admin: backfill recent calls from Vapi ──────────────────────
// Superadmin-only. Pulls the most recent calls straight from Vapi's REST
// API and upserts them, catching anything the webhook missed (inbound or
// outbound) — e.g. when a phone number's per-number Server URL didn't
// carry the auth header, so end-of-call reports 401'd. Safe to run anytime;
// upsertCall is idempotent on call id.
app.get('/api/_admin/sync-calls', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  if (!process.env.VAPI_API_KEY) return res.status(503).json({ error: 'VAPI_API_KEY not set' });
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const r = await axios.get('https://api.vapi.ai/call', {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
      params : { limit },
      timeout: 20_000,
    });
    const calls = Array.isArray(r.data) ? r.data : [];
    let matched = 0;
    for (const v of calls) {
      const cid = await upsertVapiCall(v);
      if (cid) matched++;
    }
    audit(req, 'admin.sync_calls', null, { fetched: calls.length, matched });
    res.json({ success: true, fetched: calls.length, matched, unmatched: calls.length - matched });
  } catch (e) {
    req.log.error('sync-calls failed', { err: e.response?.data || e.message });
    res.status(502).json({ success: false, error: e.response?.data?.message || e.message });
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
// Superadmin only. Returns the last 10 webhook attempts (headers
// sanitized) plus the length of VAPI_WEBHOOK_SECRET as configured on
// this server, so the operator can spot mismatches between what Vapi
// is sending and what Railway has in its env vars.
app.get('/api/_debug/recent-webhooks', async (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  const raw     = process.env.VAPI_WEBHOOK_SECRET || '';
  const trimmed = raw.trim();
  res.json({
    serverEnv: {
      raw_length    : raw.length,
      trimmed_length: trimmed.length,
      first8        : trimmed.slice(0, 8),
      last4         : trimmed.slice(-4),
      has_whitespace: raw.length !== trimmed.length,
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
  // unvalidated id is accepted here but only fails much later, at Vapi sync,
  // as "Couldn't Find 11labs Voice" — which is exactly the production
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
  for (const k of ['temperature', 'maxTokens', 'stability', 'similarityBoost', 'optimizeStreamingLatency', 'voiceSpeed']) {
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
  // Per-company Vapi phone-number IDs (outbound is used to place calls;
  // inbound is stored for reference — inbound routing is bound in Vapi).
  for (const k of ['outboundPhoneNumberId', 'inboundPhoneNumberId']) {
    if (typeof b[k] === 'string') clean[k] = b[k].trim().slice(0, 80);
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
  // wipe the rest (phone-number IDs, caps...).
  let existing = {};
  try { if (row.settings) existing = JSON.parse(row.settings) || {}; } catch {}
  const merged = { ...existing, ...clean };
  await sql.updateCompanySettings.run({ id: row.id, settings: JSON.stringify(merged) });
  invalidateCache(row.id);
  audit(req, 'company.settings', `companies/${row.id}`, Object.keys(clean));
  res.json({ settings: merged });
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
    assistant_id  : null,
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
  await sql.updateCompany.run({
    id            : existing.id,
    name          : b.name          ?? existing.name,
    language      : b.language      ?? existing.language,
    voice_id      : b.voiceId       ?? existing.voice_id,
    phone_number  : b.phoneNumber   ?? existing.phone_number,
    assistant_id  : b.assistantId   ?? existing.assistant_id,
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
  // latest state from Vapi and upsert. Covers two cases:
  //   1. Outbound call we just initiated — webhook hasn't arrived yet.
  //   2. Webhook arrived but never reached us (misconfigured URL, signature
  //      mismatch, etc). Without this, the row stays as a permanent stub.
  const needsRefresh = (!call.transcript || !call.ended_reason) && process.env.VAPI_API_KEY;
  if (needsRefresh) {
    try {
      const r = await axios.get(`https://api.vapi.ai/call/${encodeURIComponent(call.id)}`, {
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
        timeout: 10_000,
      });
      const v = r.data || {};
      const startedAt = v.startedAt || null;
      const endedAt   = v.endedAt   || null;
      const duration  = startedAt && endedAt
        ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000)
        : (call.duration_sec || null);
      const direction = String(v.type || '').toLowerCase().includes('outbound')
        ? 'outbound' : (call.direction || 'inbound');
      await sql.upsertCall.run({
        id            : call.id,
        company_id    : call.company_id,
        assistant_id  : v.assistantId || call.assistant_id || null,
        caller_number : v.customer?.number || call.caller_number || null,
        duration_sec  : duration,
        started_at    : startedAt || call.started_at || null,
        ended_at      : endedAt   || call.ended_at   || null,
        ended_reason  : v.endedReason || call.ended_reason || null,
        transcript    : v.artifact?.transcript || v.transcript || call.transcript || null,
        summary       : v.summary || call.summary || null,
        cost_usd      : v.cost ?? call.cost_usd ?? null,
        direction,
        recording_url : v.artifact?.recordingUrl || v.recordingUrl || call.recording_url || null,
        structured_data: v.analysis?.structuredData ? JSON.stringify(v.analysis.structuredData) : (call.structured_data || null),
      });
      call = await sql.getCall.get(call.id);
    } catch (e) {
      req.log.warn('vapi call refresh failed', { err: e.message, callId: call.id });
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

// Vapi sync: rebuild the Vapi assistant from the company's ACTIVE SCENARIO.
// Everything that matters — system prompt, first message, success criteria,
// variable list — comes from the scenario row. Pressing this button is the
// only thing that should change what callers hear on the phone, so the
// /admin Scenarios page is the only source of truth.
app.post('/api/companies/:id/sync-vapi', requireCompanyAccess, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  // Optional override: ?force=1 wipes the stored assistantId before sync.
  // Forces a clean rebuild on Vapi — useful when the user has deleted the
  // assistant from the dashboard and our PATCH would otherwise be silent.
  if (req.query.force === '1' && c.assistantId) {
    await dataRun('UPDATE companies SET assistant_id = NULL WHERE id = ?', [c.id]);
    invalidateCache(c.id);
    Object.assign(c, { assistantId: null });
  }

  const scenarioRow = await sql.getActiveScenarioForCompany.get(c.id);
  if (!scenarioRow || !scenarioRow.instruction_prompt) {
    return res.status(409).json({
      error: 'فعّل سيناريو أولاً قبل النشر — الـ Vapi assistant بيتبني من السيناريو النشط.',
      code : 'NO_ACTIVE_SCENARIO',
    });
  }
  const scenario = shapeScenario(scenarioRow);

  // Compose the exact prompt the assistant runs on. Shared with the draft
  // tester and the prompt preview so all three are identical.
  let systemContent = await composeSystemPrompt(c, scenario.instructionPrompt);

  // DEFAULT_VOICE_ID is the source of truth for the agent's voice. We ignore
  // company.voice_id here because it gets stamped at seed time and becomes
  // stale the moment you change voices globally. A company can still override
  // the voice via settings.voiceId (admin UI), which takes precedence.
  // Per-company overrides (c.settings) fall back to these tuned defaults.
  // Everything is clamped so a bad value can't produce an invalid assistant.
  const s = c.settings || {};
  const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);
  const voiceId       = s.voiceId || DEFAULT_VOICE_ID;
  // Quality-first defaults (real-estate call center): full gpt-4.1 is far more
  // faithful to the KB and hallucinates less in Arabic than the mini models.
  // Legacy mini selections are honored if a company explicitly picked one.
  // Resolved by the SAME helper the draft tester and text chat use, so all
  // three channels are guaranteed to agree.
  const { model, temperature, maxTokens } = resolveAgentModel(c);
  const stability     = clamp(s.stability, 0, 1, 0.8);
  const similarity    = clamp(s.similarityBoost, 0, 1, 0.8);
  // optimizeStreamingLatency default is 4 (max) — the operator asked sync to
  // produce the fastest streaming. A company can still override it via the
  // voice-settings slider; env VOICE_LATENCY_DEFAULT tunes the default without
  // a deploy. NOTE: level 4 is the most aggressive and trims some ElevenLabs
  // text normalization, so if numbers/prices start sounding off, drop to 3.
  const streamLatency = clamp(s.optimizeStreamingLatency, 0, 4, VOICE_LATENCY_DEFAULT);
  // Speaking pace. 1.0 = ElevenLabs default. Default is 1.2 (faster) per the
  // operator's request; no per-company UI, so this is what every sync uses
  // unless VOICE_SPEED_DEFAULT overrides it.
  const voiceSpeed    = clamp(s.voiceSpeed, 0.7, 1.2, VOICE_SPEED_DEFAULT);

  const cfg = {
    name: `smart-assistant:${c.id}`,
    model: {
      // gpt-4.1 default (quality-first, most faithful Saudi Arabic). Overridable
      // per-company via settings. endCall tool wired so the model can hang up.
      provider   : 'openai', model, temperature, maxTokens,
      tools      : [{ type: 'endCall' }],
      messages   : [{ role: 'system', content: systemContent }],
    },
    voice: {
      provider: '11labs', voiceId,
      // Quality-first: turbo v2.5 is a clear quality step up from flash while
      // keeping latency low enough for live phone conversation.
      model: 'eleven_turbo_v2_5',
      stability, similarityBoost: similarity,
      useSpeakerBoost: true,
      speed: voiceSpeed,
      optimizeStreamingLatency: streamLatency,
    },
    // Google Gemini STT, language pinned to Arabic (was Multilingual). On calls
    // that are ~100% Saudi Arabic, pinning ar cuts language-confusion errors and
    // stray non-Arabic tokens vs Multilingual — and still far better than Azure
    // ar-SA. Accuracy > latency here. (User set this in Vapi and made it default.)
    //
    // MEASURED COST (145 real turns, Vapi performanceMetrics): this transcriber
    // is the dominant latency source — 2259ms median STT (47% of turn) and it
    // does NOT scale with utterance length (2076ms for 1-3 words vs 2103ms for
    // 4-8), i.e. it is fixed overhead, not transcription work. Because it emits
    // no punctuated streaming partials, endpointing also falls through to the
    // no-punctuation timeout every turn (another 1501ms / 31%). Together: 78%
    // of turn latency. Overridable via TRANSCRIBER_JSON so an alternative can
    // be A/B'd against the same metric; re-measure with scripts/profile-calls.js.
    transcriber: TRANSCRIBER,
    // Post-call lead qualification: Vapi's analysis model fills this schema
    // from the transcript and sends it in the end-of-call report
    // (analysis.structuredData) — stored in calls.structured_data and shown
    // as lead chips in the call details. Analysis config, not prompt text.
    analysisPlan: {
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: 'object',
          properties: {
            interest_level      : { type: 'string', enum: ['مهتم جدا', 'مهتم', 'متردد', 'غير مهتم'], description: 'مستوى اهتمام العميل بالعرض' },
            property_type       : { type: 'string', description: 'نوع العقار المطلوب (شقة، فيلا، أرض، مكتب...) إن ذُكر' },
            budget              : { type: 'string', description: 'الميزانية المذكورة بالريال إن ذُكرت' },
            preferred_area      : { type: 'string', description: 'الحي أو المنطقة المفضلة إن ذُكرت' },
            callback_requested  : { type: 'boolean', description: 'هل طلب العميل التواصل معه لاحقاً' },
            appointment_requested: { type: 'boolean', description: 'هل طلب العميل موعد معاينة أو زيارة' },
            notes               : { type: 'string', description: 'ملاحظة مهمة واحدة للمبيعات إن وجدت' },
            // Added for the campaign report. Vapi's analysis model fills these
            // from the transcript it already has, so they cost no extra call
            // and no caller-facing latency. Calls made BEFORE this sync simply
            // lack them — lib/lead-scoring composes equivalents from the
            // fields above, which is why the report works on historical data.
            customer_intent     : { type: 'string', description: 'ماذا يريد العميل بالضبط في جملة واحدة قصيرة' },
            next_action         : { type: 'string', description: 'الإجراء التالي المقترح لفريق المبيعات في جملة واحدة' },
          },
        },
      },
      // Summaries were coming back in ENGLISH for Arabic calls (Vapi's default
      // prompt), which makes the report unreadable for a Saudi sales team.
      // This is analysis configuration, not agent instructions — it does not
      // touch the operator's scenario text.
      summaryPlan: {
        enabled: true,
        messages: [
          { role: 'system', content: 'أنت محلل مكالمات. لخّص المكالمة بالعربية في جملتين إلى ثلاث جمل كحد أقصى. اذكر ما طلبه العميل ونتيجة المكالمة فقط. لا تخترع معلومات غير موجودة في النص.' },
          { role: 'user', content: 'نص المكالمة:\n\n{{transcript}}' },
        ],
      },
    },
    // Inbound default: the assistant-level firstMessage is what an unknown
    // caller hears, so it must NOT depend on customer_name. We use the
    // scenario's inbound variant, falling back to the outbound version
    // (still better than a 404), then to a generic Saudi greeting.
    firstMessage     : scenario.firstMessageInbound
                    || scenario.firstMessage
                    || `حياك الله في ${c.name}، كيف يقدر أساعدك؟`,
    firstMessageMode : 'assistant-speaks-first',
    backgroundDenoisingEnabled: true,
    maxDurationSeconds: 600,
    // Vapi-side safety net: ends the call when the CUSTOMER utters one of these,
    // independent of whether the model decides to invoke endCall. The old list
    // required the exact phrase "شكراً مع السلامة" together, so a bare
    // "مع السلامة" (what callers actually say) never matched and the call hung
    // open. Cover the common Saudi farewells and both ة/ه spellings. Kept to
    // genuine sign-offs only — no bare "شكراً", which callers say mid-call.
    endCallPhrases   : [
      'مع السلامة', 'مع السلامه', 'في أمان الله', 'بأمان الله',
      'باي باي', 'باي', 'goodbye', 'bye',
    ],
    // Silence handling: after 8s of customer silence the agent prompts them
    // with an idle line ("are you still with me?"), then again up to 2 more
    // times. If the total session silence ever hits silenceTimeoutSeconds
    // the call ends — set short (30s) so dead calls don't linger.
    messagePlan: {
      // Phrasing tuned to sound like a real Saudi rep checking in — not a
      // canned "are you still there?". Rotates so the customer doesn't hear
      // the same line twice if they pause more than once.
      idleMessages: [
        'ألو أستاذي، معاي؟',
        'أسمعك، تفضّل.',
        'ممكن أكون فقدت الصوت عندك، إذا تسمعني أنا معك.',
      ],
      idleMessageMaxSpokenCount: 2,
      // 7 → 15s. On an OUTBOUND call the line is connecting/ringing for a few
      // seconds before the callee answers; a short idle timer fired the
      // "ألو معاي؟" check-in BEFORE the opening message. 15s lets the call
      // connect + the first message play first, and still checks in if the
      // customer genuinely goes silent mid-call.
      idleTimeoutSeconds: 15,
    },
    silenceTimeoutSeconds: 30,
    // 0.3 → 0.15s: the agent starts responding sooner after the user stops
    // talking, cutting perceived latency without touching answer quality.
    // smartEndpointingEnabled ('livekit' ML end-of-speech detection) still
    // guards against cutting the customer off mid-sentence, so the lower
    // waitSeconds only trims the dead pause at the tail of their turn.
    startSpeakingPlan: {
      waitSeconds: 0.15,
      smartEndpointingEnabled: 'livekit',
      // MEASURED: endpointing costs 1501ms on 44 of 53 profiled turns — an
      // exact constant, which is Vapi's onNoPunctuationSeconds default (1.5s)
      // firing. It fires every turn because the current transcriber emits no
      // punctuated streaming partials, so the 0.1s punctuation path never runs.
      // Turns that avoided it came in at 100-452ms endpointing and a 2001ms
      // TOTAL turn, vs the 4823ms median — so this is the cheapest large win
      // available. 1.0s trims ~500ms of dead air with no effect on
      // transcription accuracy or voice quality; raise it if callers report
      // being cut off. Values are env-tunable for A/B without a redeploy.
      transcriptionEndpointingPlan: {
        onPunctuationSeconds  : num(process.env.ENDPOINT_PUNCT_S, 0.1),
        onNoPunctuationSeconds: num(process.env.ENDPOINT_NOPUNCT_S, 1.0),
        onNumberSeconds       : num(process.env.ENDPOINT_NUMBER_S, 0.4),
      },
    },
    // Aggressive interrupt: stop the agent the instant the user starts
    // speaking. numWords 1 (vs 2) means a single syllable triggers a stop;
    // voiceSeconds 0.1 (vs 0.2) shortens the voice-activity confirmation;
    // backoffSeconds 0.5 (vs 1.0) means it doesn't sulk for a full second
    // after being cut off.
    stopSpeakingPlan : { numWords: 1, voiceSeconds: 0.1, backoffSeconds: 0.5 },
  };

  // ── Optional tools (added by capability, never by wording — when/why to
  // use them is the operator's scenario text, untouched by us) ─────────
  // Human transfer: settings.transferPhoneNumber gives the model a
  // transferCall tool with the company's escalation number.
  const transferNumber = String(s.transferPhoneNumber || '').trim();
  if (/^\+[0-9]{8,15}$/.test(transferNumber)) {
    cfg.model.tools.push({
      type: 'transferCall',
      destinations: [{ type: 'number', number: transferNumber }],
    });
  }

  // Live KB retrieval: when the company has KB chunks and our public URL is
  // known, add a function tool that searches the KB mid-call. The static KB
  // bake in the system prompt stays (fast path); the tool covers what the
  // KB_INJECT_CAP truncation dropped — the main voice-hallucination source.
  const kbChunkCount = await sql.countCompanyChunks.get(c.id)?.n || 0;
  if (kbChunkCount > 0 && PUBLIC_BASE_URL) {
    cfg.model.tools.push({
      type: 'function',
      async: false,
      function: {
        name: 'search_knowledge_base',
        description: 'البحث في قاعدة معرفة الشركة عن معلومة محددة (أسعار، مشاريع، مواصفات، عروض) عندما لا تكون المعلومة متوفرة في تعليماتك. استخدمها قبل أن تقول إن المعلومة غير متوفرة.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'نص السؤال أو الكلمات المفتاحية للبحث' },
          },
          required: ['query'],
        },
      },
      server: {
        url: `${PUBLIC_BASE_URL}/webhook/vapi`,
        secret: (process.env.VAPI_WEBHOOK_SECRET || '').trim() || undefined,
        timeoutSeconds: 10,
      },
    });
  }

  const headers = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' };
  const vapiOpts = { headers, timeout: VAPI_TIMEOUT_MS };
  try {
    // Primary (outbound/default) assistant.
    const assistantId = await upsertVapiAssistant(cfg, c.assistantId, vapiOpts, req.log);

    // Optional inbound assistant (Phase 3) — only when the scenario defines a
    // separate inbound prompt. Otherwise inbound uses the primary assistant,
    // so existing companies are completely unaffected.
    let inboundAssistantId = null;
    const inboundPrompt = (scenario.instructionPromptInbound || '').trim();
    if (inboundPrompt) {
      const inboundCfg = {
        ...cfg,
        name: `smart-assistant:${c.id}:inbound`,
        model: { ...cfg.model, messages: [{ role: 'system', content: await composeSystemPrompt(c, inboundPrompt) }] },
        firstMessage: scenario.firstMessageInbound || cfg.firstMessage,
      };
      inboundAssistantId = await upsertVapiAssistant(inboundCfg, c.assistantIdInbound, vapiOpts, req.log);
    }

    // Stamp last_synced_at so the UI can show "unpublished changes" when
    // the active scenario gets edited after a sync.
    await sql.setCompanySynced.run(assistantId, c.id);
    await sql.setCompanyInboundAssistant.run({ id: c.id, aid: inboundAssistantId });
    invalidateCache(c.id);
    res.json({ assistantId, inboundAssistantId, scenarioId: scenario.id, scenarioName: scenario.name });
  } catch (e) {
    req.log.error('vapi sync error', { err: e.response?.data || e.message, companyId: c.id });
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// Bind the configured phone number to this company's assistant. Vapi has
// exactly one configured number per `VAPI_PHONE_NUMBER_ID`; binding it to a
// new assistant transfers ownership. We commit the DB change ONLY after Vapi
// confirms success, and we only clear the previous owner of THIS specific
// phone number (not every company in the table).
app.post('/api/companies/:id/bind-phone', requireCompanyAdmin, async (req, res) => {
  const c = await loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!c.assistantId) return res.status(400).json({ error: 'انشر الشركة على Vapi أولاً.' });

  const headers = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' };
  const vapiOpts = { headers, timeout: VAPI_TIMEOUT_MS };

  // Inbound number for THIS company — MUST come from the company's own
  // settings. We deliberately do NOT fall back to the platform env var: with
  // multiple companies that fallback would bind another company's number
  // (e.g. Maheer grabbing Wakan's outbound number). Require it explicitly.
  const phoneId = c.settings?.inboundPhoneNumberId;
  if (!phoneId) {
    return res.status(400).json({ error: 'اضبط معرّف الرقم الوارد لهذه الشركة في إعدادات الصوت أولاً (حتى لا يُربط رقم شركة أخرى).' });
  }
  const targetAssistant = c.assistantIdInbound || c.assistantId;
  try {
    const r = await axios.patch(`https://api.vapi.ai/phone-number/${phoneId}`, { assistantId: targetAssistant }, vapiOpts);
    const newNumber = r.data.number;
    // Vapi succeeded — now reflect the move in DB atomically.
    await withTransaction(async () => {
      await dataRun('UPDATE companies SET phone_number = NULL WHERE phone_number = ?', [newNumber]);
      await dataRun(`UPDATE companies SET phone_number = ?, updated_at = ${NOW_SQL} WHERE id = ?`, [newNumber, c.id]);
    });
    invalidateCache();
    audit(req, 'vapi.phone_bind', `companies/${c.id}`, { phoneNumber: newNumber, assistantId: targetAssistant });
    res.json({ phoneNumber: newNumber, assistantId: targetAssistant });
  } catch (e) {
    req.log.error('phone bind error', { err: e.response?.data || e.message, companyId: c.id });
    res.status(500).json({ error: e.response?.data?.message || e.message });
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
  // The user can click into it to trigger an on-demand Vapi pull which
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
      r.summary, r.recording_url,
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
    // Outbound (Vapi calls the customer; we know who's on the line).
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
// KB dump (capped) + endCall wiring — so a company can see what Vapi actually
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
3. instruction prompt تفصيلي بالعربية يحتوي على الأقسام:
   - AGENT IDENTITY & PURPOSE
   - TONE & STYLE (Saudi Najdi Arabic dialect, lahjet اللهجة السعودية)
   - CONVERSATION FLOW (خطوات الحوار بالترتيب)
   - INFORMATION TO COLLECT
   - ESCALATION & TRANSFER RULES
   - END CALL CONDITIONS
   - SAFETY & PRIVACY (مش يكشف معلومات داخلية، مش يخترع حقائق)
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
