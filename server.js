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
const { db, sql } = require('./db');
const { loadCompany, listCompaniesFull, invalidateCache, buildSystemPromptWithRAG, fillGlobals } = require('./companies');
const { summarize, chatToTranscript } = require('./summarize');
const { ingestDocument, retrieve } = require('./lib/rag');
const { END_CALL_TOOL_RULE } = require('./lib/master-prompt');
const loopchat = require('./lib/loopchat');
const { lintScenario } = require('./lib/scenario-lint');
const authRoutes = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const { requireAuth, requireCompanyAccess, requireCompanyAdmin, canChatWithCompany, startSessionCleanup } = require('./lib/auth');
const { logger } = require('./lib/logger');

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
const TTS_TIMEOUT_MS    = 15_000;
const VAPI_TIMEOUT_MS   = 20_000;

const openai = new OpenAI({
  apiKey : process.env.OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT_MS,
  maxRetries: 1,
});
const app = express();

// Trust proxy hops in front of Node. Misconfiguration here lets attackers
// spoof X-Forwarded-For and bypass per-IP rate limits + lockout. Set to:
//   0  — Node is exposed directly (no proxy). DEFAULT, safest.
//   1  — exactly one trusted proxy (e.g. nginx OR Cloudflare).
//   2+ — chained proxies (e.g. Cloudflare → nginx).
// Configure via `TRUST_PROXY` env var to match your real deployment.
const TRUST_PROXY = Number.isFinite(Number(process.env.TRUST_PROXY))
  ? Number(process.env.TRUST_PROXY)
  : 0;
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
app.use((req, res, next) => {
  const incoming = String(req.get('x-request-id') || '').slice(0, 64);
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
    ? incoming
    : crypto.randomBytes(8).toString('hex');
  req.id  = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('X-Request-Id', id);
  next();
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
app.get('/c/:companyId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Auth routes mount BEFORE the global /api auth gate.
app.use('/api/auth', authRoutes);

// Public-safe view of a company. Used by the client login page to render the
// company branding before the user is authenticated, and by the post-login
// customer experience to render the phone-call panel. `phoneNumber` is
// included because it's marketing-grade info already advertised by the
// business; voiceId, system prompt, and KB stay hidden.
app.get('/api/public/companies/:id', (req, res) => {
  if (!COMPANY_ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  const c = loadCompany(req.params.id);
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
// External integrations (e.g. LoopChat for WhatsApp) POST a customer
// message here and get the AI agent's text reply. Same pipeline as the
// Twilio WhatsApp webhook — calls Vapi /chat with previousChatId resumed
// from the whatsapp_sessions table — but exposed as a server-to-server
// REST endpoint authenticated via a Bearer API key (env: AGENT_API_KEY).
// Mounted before requireAuth so callers don't need a logged-in session.
app.post('/api/v1/agent/chat', async (req, res) => {
  const expected = (process.env.AGENT_API_KEY || '').trim();
  if (!expected) {
    return res.status(503).json({ success: false, error: 'AGENT_API_KEY not configured on server' });
  }
  const authHeader = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  const provided = (m?.[1] || req.get('x-api-key') || '').trim();
  if (!provided) {
    return res.status(401).json({ success: false, error: 'missing api key' });
  }
  let ok = false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {}
  if (!ok) return res.status(401).json({ success: false, error: 'invalid api key' });

  const companyId     = String(req.body?.company_id || '').trim();
  const customerPhone = String(req.body?.customer_phone || '').trim();
  const message       = String(req.body?.message || '').trim();
  if (!COMPANY_ID_RE.test(companyId)) {
    return res.status(400).json({ success: false, error: 'company_id is required' });
  }
  if (!customerPhone) {
    return res.status(400).json({ success: false, error: 'customer_phone is required' });
  }
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  if (message.length > MAX_USER_MSG_CHARS) {
    return res.status(413).json({ success: false, error: 'message too long' });
  }

  const company = loadCompany(companyId);
  if (!company) {
    return res.status(404).json({ success: false, error: 'company not found' });
  }
  if (!company.assistantId) {
    return res.status(409).json({ success: false, error: 'company not published to Vapi' });
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
  const prev = sql.getWhatsappSession.get(company.id, customerPhone);
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
  sql.upsertWhatsappSession.run({
    company_id    : company.id,
    customer_phone: customerPhone,
    vapi_chat_id  : newChatId || null,
  });

  // Log to chats so the conversation shows up in the dashboard.
  try {
    sql.insertChat.run({
      company_id     : company.id,
      session_id     : 'api-' + customerPhone.replace(/[^0-9]/g, ''),
      user_message   : message,
      assistant_reply: reply || '',
      channel        : 'whatsapp',
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

// ─── helpers ─────────────────────────────────────────────────────
const COMPANY_ID_RE  = /^[a-z0-9-]{1,40}$/;
const MAX_HISTORY    = 20;        // max messages forwarded to the LLM per turn
const MAX_MSG_CHARS  = 2000;      // per-message cap
const MAX_USER_MSG_CHARS = 4000;  // per-user-turn cap
const TTS_DAILY_CAP_CHARS = 60000;       // ~60k chars/day = a few hours of voice

function resolveCompany(req, res) {
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
  const company = loadCompany(companyId);
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

// Today's date in YYYY-MM-DD (UTC) — used as the bucket key for usage counters.
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function audit(req, action, resource, metadata) {
  try {
    sql.logAuditEvent.run({
      actor_id    : req.user?.id || null,
      actor_email : req.user?.email || null,
      action,
      resource    : resource || null,
      metadata    : metadata ? JSON.stringify(metadata) : null,
      ip          : req.ip || req.socket?.remoteAddress || null,
      user_agent  : (req.get('user-agent') || '').slice(0, 255),
    });
  } catch (e) {
    logger.error('audit log error', { err: e.message });
  }
}

async function askGPT(company, message, history, vars) {
  const systemContent = await buildSystemPromptWithRAG(company, message, vars);
  const messages = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: message },
  ];
  const t0 = Date.now();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini', messages, max_tokens: 300, temperature: 0.7,
  });
  return { reply: completion.choices[0].message.content, ms: Date.now() - t0, usage: completion.usage };
}

function ttsStream(text, voiceId) {
  return axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      text, model_id: 'eleven_flash_v2_5', output_format: 'mp3_44100_64',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      responseType: 'stream',
      timeout: TTS_TIMEOUT_MS,
    }
  );
}

function getOrMakeSessionId(req) {
  return req.body?.sessionId || req.headers['x-session-id'] || crypto.randomUUID();
}

// ─── Public routes ───────────────────────────────────────────────
app.get('/', (_req, res) => res.redirect('/admin/'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/chat', chatLimiter, requireAuth, async (req, res) => {
  const ctx = resolveCompany(req, res);
  if (!ctx) return;
  if (!canChatWithCompany(req.user, ctx.company.id)) {
    return res.status(403).json({ error: 'لا تملك صلاحية محادثة هذه الشركة' });
  }
  const sessionId = getOrMakeSessionId(req);
  try {
    const r = await askGPT(ctx.company, ctx.message, ctx.history, ctx.vars);
    sql.insertChat.run({
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
// All three are Saudi-Arabic male voices already on the account.
const PLAYGROUND_VOICES = [
  { id: 'cFUFIbKkO2iZFwS8cRnY', name: 'Nasser', label: 'ناصر', description: 'صوت سعودي طبيعي', gender: 'male', accent: 'saudi' },
];
const PLAYGROUND_VOICE_IDS = new Set(PLAYGROUND_VOICES.map((v) => v.id));

app.get('/api/voices', requireAuth, (_req, res) => {
  res.json(PLAYGROUND_VOICES);
});

// Outbound call: Vapi rings the user's phone using the company's synced
// assistant. No WebRTC needed in the browser — Vapi handles the full PSTN
// pipeline. Same assistant as a real customer call → same prompt, same voice,
// same transcriber, real production behaviour.
app.post('/api/companies/:id/outbound-call', requireCompanyAccess, async (req, res) => {
  const c = loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'company not found' });
  if (!c.assistantId) {
    return res.status(409).json({ error: 'انشر الشركة على Vapi أولاً.', code: 'NOT_PUBLISHED' });
  }
  if (!process.env.VAPI_PHONE_NUMBER_ID) {
    return res.status(503).json({ error: 'VAPI_PHONE_NUMBER_ID مش متضبط في .env' });
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
  const activeScenario = sql.getActiveScenarioForCompany.get(c.id);
  if (activeScenario?.first_message) {
    overrides.firstMessage = activeScenario.first_message;
  }

  try {
    const r = await axios.post(
      'https://api.vapi.ai/call',
      {
        assistantId       : c.assistantId,
        phoneNumberId     : process.env.VAPI_PHONE_NUMBER_ID,
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
      sql.insertOutboundCallStub.run({
        id            : r.data.id,
        company_id    : c.id,
        assistant_id  : c.assistantId,
        caller_number : phoneNumber,
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
  const c = loadCompany(req.params.id);
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
      sql.insertChat.run({
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

// ─── Vapi webhook debug capture ──────────────────────────────────
// In-memory ring buffer of the last 10 webhook attempts so the operator
// can hit /api/_debug/recent-webhooks and see EXACTLY what Vapi is sending
// when verification keeps failing. Values longer than 24 chars are masked
// (first 8 + last 4 + length) so secrets never leak verbatim into the UI.
const RECENT_WEBHOOK_MAX = 10;
const recentWebhookAttempts = [];

function maskHeaderValue(v) {
  const s = String(v ?? '');
  if (s.length <= 24) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)} (len=${s.length})`;
}

function captureWebhookAttempt(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    headers[k] = maskHeaderValue(v);
  }
  const entry = {
    at      : new Date().toISOString(),
    ip      : req.ip || null,
    bodyType: req.body?.message?.type || req.body?.type || null,
    headers,
    verified: null,
  };
  recentWebhookAttempts.push(entry);
  if (recentWebhookAttempts.length > RECENT_WEBHOOK_MAX) recentWebhookAttempts.shift();
  return entry;
}

// ─── Vapi webhook ────────────────────────────────────────────────
// Verify the request was sent by Vapi. Vapi supports several auth modes
// configured per organization in its dashboard:
//   1. Custom HTTP Headers — Vapi forwards exactly what you configured.
//      Common names: VAPI_WEBHOOK_SECRET (the one we use), X-Vapi-Secret,
//      Authorization: Bearer ...
//   2. Legacy HMAC-SHA256 over the raw body, sent in `x-vapi-signature`.
// We accept any of the above so the user can pick whichever header survives
// their reverse-proxy filtering. timingSafeEqual on every candidate.
function verifyVapiSignature(req) {
  // Trim defensively: a single trailing newline or space pasted into the
  // Railway env var makes timingSafeEqual return false even when the values
  // look identical at a glance. Cheap insurance.
  const secret = (process.env.VAPI_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    // Unset secret is fatal in production; tolerated only in development.
    return process.env.NODE_ENV !== 'production';
  }
  const candidates = [
    req.get('vapi_webhook_secret'),
    req.get('VAPI_WEBHOOK_SECRET'),
    req.get('x-vapi-secret'),
    req.get('x-vapi-webhook-secret'),
  ];
  const authHeader = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (m) candidates.push(m[1]);
  const secretBuf = Buffer.from(secret);
  for (const v of candidates) {
    if (!v) continue;
    try {
      const b = Buffer.from(String(v).trim());
      if (b.length === secretBuf.length && crypto.timingSafeEqual(b, secretBuf)) return true;
    } catch {}
  }
  // Legacy HMAC-SHA256 fallback.
  const sig = req.get('x-vapi-signature') || '';
  if (sig && req.rawBody) {
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {}
  }
  return false;
}

// Process a single Vapi event row from the inbox. Idempotent: upsertCall is
// keyed by call.id, and we no-op if a duplicate event_id was already inserted.
async function processVapiEvent(msg) {
  if (!msg) return;
  if (msg.type !== 'end-of-call-report' && msg.type !== 'status-update') return;

  const call = msg.call || {};
  const assistantId = call.assistantId || msg.assistant?.id;
  const companyRow = assistantId
    ? db.prepare('SELECT id FROM companies WHERE assistant_id = ?').get(assistantId)
    : null;

  if (msg.type === 'end-of-call-report') {
    const transcript = msg.artifact?.transcript || msg.transcript || '';
    const startedAt = call.startedAt || msg.startedAt;
    const endedAt   = call.endedAt || msg.endedAt;
    const duration  = startedAt && endedAt ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000) : null;

    // Vapi sends `type` as `inboundPhoneCall` / `outboundPhoneCall` / `webCall`.
    // We collapse everything that isn't an outbound PSTN call into 'inbound'
    // so the Conversations table has a clean two-way split.
    const callType = String(call.type || msg.type || '').toLowerCase();
    const direction = callType.includes('outbound') ? 'outbound' : 'inbound';

    sql.upsertCall.run({
      id            : call.id || crypto.randomUUID(),
      company_id    : companyRow?.id || null,
      assistant_id  : assistantId || null,
      caller_number : call.customer?.number || msg.customer?.number || null,
      duration_sec  : duration,
      started_at    : startedAt || null,
      ended_at      : endedAt || null,
      ended_reason  : msg.endedReason || call.endedReason || null,
      transcript    : transcript || null,
      summary       : msg.summary || null,
      cost_usd      : msg.cost || call.cost || null,
      direction,
    });

    if (transcript && (!msg.summary || msg.summary.length < 20)) {
      const ours = await summarize(transcript);
      if (ours) sql.setCallSummary.run(ours, call.id);
    }

    // Post-call WhatsApp template via LoopChat. Skipped silently when the
    // template UUID isn't configured (so the integration is opt-in per env).
    // Only fires for real conversations (>=30s) and when we have a customer
    // number to message. Fire-and-forget — failures are logged, never raised.
    const tplUuid    = process.env.LOOPCHAT_TEMPLATE_UUID_CALL_SUMMARY;
    const recipient  = call.customer?.number || msg.customer?.number || null;
    if (tplUuid && recipient && (duration || 0) >= 30) {
      const company    = companyRow ? loadCompany(companyRow.id) : null;
      const companyNm  = company?.name || 'فريق المبيعات';
      const finalSummary = msg.summary || sql.getCall.get(call.id)?.summary || '';
      const summaryShort = String(finalSummary).slice(0, 240) || 'تم استلام طلبك';
      loopchat.sendTemplateBestEffort(
        {
          recipient,
          templateUuid : tplUuid,
          // Keys are template placeholder numbers ({{1}}, {{2}}, ...). The
          // user defines the template body in LoopChat's dashboard; make
          // sure the placeholders line up with the order below.
          bodyVariables: {
            '1': companyNm,
            '2': summaryShort,
          },
        },
        { companyId: companyRow?.id || null, callId: call.id },
      );
    }
  }
}

// Drain up to N pending webhook events on a tick. Called best-effort from the
// webhook handler so failed events get retried whenever new traffic arrives.
async function drainWebhookInbox(limit = 5) {
  const pending = sql.listPendingWebhooks.all(limit);
  for (const ev of pending) {
    try {
      const parsed = JSON.parse(ev.raw_body);
      await processVapiEvent(parsed.message || parsed);
      sql.markWebhookProcessed.run(ev.id);
    } catch (e) {
      sql.markWebhookFailed.run(e.message?.slice(0, 500) || 'unknown', ev.id);
      logger.error('webhook drain failed', { eventId: ev.id, err: e.message });
    }
  }
}

app.post('/webhook/vapi', async (req, res) => {
  // Capture every attempt so the operator can inspect what Vapi actually sent
  // when verification fails (header names + sanitized values, body type).
  const captured = captureWebhookAttempt(req);
  if (!verifyVapiSignature(req)) {
    captured.verified = false;
    req.log.warn('vapi webhook: signature verification failed', captured);
    return res.status(401).json({ error: 'invalid signature' });
  }
  captured.verified = true;

  // 1. Persist the raw payload before doing anything else. If processing or
  // the process itself dies, the event survives in the inbox for retry.
  const msg = req.body?.message;
  const eventId = msg?.call?.id || msg?.id || null;
  let row;
  try {
    const result = sql.insertWebhookEvent.run({
      provider  : 'vapi',
      event_id  : eventId,
      event_type: msg?.type || null,
      raw_body  : req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}),
    });
    row = result.lastInsertRowid;
  } catch (e) {
    req.log.error('webhook inbox insert failed', { err: e.message });
  }

  // 2. Ack Vapi immediately — at-least-once delivery means they won't retry.
  res.json({ ok: true });

  // 3. Process inline, then drain any stragglers from prior failures.
  try {
    await processVapiEvent(msg);
    if (row) sql.markWebhookProcessed.run(row);
  } catch (e) {
    if (row) sql.markWebhookFailed.run(e.message?.slice(0, 500) || 'unknown', row);
    req.log.error('vapi webhook processing failed', { err: e.message });
  }

  // 4. Best-effort: pick up older failures while we're already on a worker thread.
  try { await drainWebhookInbox(5); } catch (e) { req.log.error('drain failed', { err: e.message }); }
});

// ─── Twilio WhatsApp webhook ─────────────────────────────────────
// Receives inbound WhatsApp messages from Twilio, runs them through the
// same Vapi assistant the phone calls use, and replies via the Twilio
// Messages API. The Twilio sandbox URL should be set to:
//   POST https://<host>/webhook/twilio-whatsapp
//
// Body comes as application/x-www-form-urlencoded (Twilio's default), so
// we mount a urlencoded parser scoped to this route only.

// Twilio's signature scheme: HMAC-SHA1(authToken, URL + concat(sortedParams))
// base64-encoded. Reject anything that doesn't match unless we're in dev
// without an auth token configured (so local sandbox testing isn't blocked).
function verifyTwilioSignature(req, fullUrl) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return process.env.NODE_ENV !== 'production';
  const sig = req.get('x-twilio-signature') || '';
  if (!sig) return false;
  const params = req.body || {};
  const sorted = Object.keys(params).sort();
  const payload = fullUrl + sorted.map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(payload).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch { return false; }
}

// Reply over the Twilio Messages API. Returns the message SID or throws.
async function sendWhatsappReply(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) throw new Error('Twilio WhatsApp not configured');
  const form = new URLSearchParams({ From: from, To: to, Body: body }).toString();
  const r = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    form,
    {
      auth   : { username: sid, password: token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    },
  );
  return r.data?.sid;
}

app.post(
  '/webhook/twilio-whatsapp',
  express.urlencoded({ extended: false, limit: '1mb' }),
  async (req, res) => {
    // Reconstruct the URL Twilio signed (must match what's set in the console).
    const fullUrl = (req.protocol + '://' + req.get('host') + req.originalUrl).split('?')[0];
    if (!verifyTwilioSignature(req, fullUrl)) {
      req.log.warn('twilio: bad signature', { url: fullUrl });
      return res.status(403).send('bad signature');
    }

    const from = String(req.body.From || '');         // e.g. whatsapp:+9665XXXXXXXX
    const body = String(req.body.Body || '').trim();
    if (!from || !body) return res.status(200).send('');  // ignore status callbacks etc.

    // Sandbox: every message routes to one configured company. Production
    // would map each WhatsApp number to its own company.
    const companyId = process.env.TWILIO_DEFAULT_COMPANY_ID;
    if (!companyId) {
      req.log.error('twilio: TWILIO_DEFAULT_COMPANY_ID not set');
      return res.status(200).send('');
    }
    const company = loadCompany(companyId);
    if (!company?.assistantId) {
      req.log.error('twilio: company not published', { companyId });
      try { await sendWhatsappReply(from, 'الخدمة غير متاحة حالياً. حاول لاحقاً.'); } catch {}
      return res.status(200).send('');
    }

    // Resume the existing Vapi chat thread for this customer if we have one.
    const prev = sql.getWhatsappSession.get(company.id, from);
    const previousChatId = prev?.vapi_chat_id || undefined;

    const t0 = Date.now();
    let reply = '';
    let newChatId = previousChatId;
    try {
      const r = await axios.post(
        'https://api.vapi.ai/chat',
        { assistantId: company.assistantId, input: body, previousChatId },
        {
          headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: VAPI_TIMEOUT_MS,
        },
      );
      reply = (r.data.output || []).map((m) => m.content).filter(Boolean).join('\n').trim();
      newChatId = r.data.id || newChatId;
    } catch (e) {
      // Vapi chat IDs expire — if the previous one is gone, retry without it.
      if (previousChatId && /not found|invalid/i.test(e.response?.data?.message || '')) {
        try {
          const r = await axios.post(
            'https://api.vapi.ai/chat',
            { assistantId: company.assistantId, input: body },
            {
              headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
              timeout: VAPI_TIMEOUT_MS,
            },
          );
          reply = (r.data.output || []).map((m) => m.content).filter(Boolean).join('\n').trim();
          newChatId = r.data.id;
        } catch (e2) {
          req.log.error('twilio: vapi chat (retry) failed', { err: e2.message });
        }
      } else {
        req.log.error('twilio: vapi chat failed', { err: e.message, status: e.response?.status });
      }
    }

    if (!reply) reply = 'تعذّر الرد حالياً. جرّب بعد دقيقة.';
    const latency = Date.now() - t0;

    // Persist the session id so the next inbound message resumes the thread.
    sql.upsertWhatsappSession.run({
      company_id: company.id, customer_phone: from, vapi_chat_id: newChatId || null,
    });

    // Log to the chats table so it shows up in the Conversations + Dashboard
    // alongside voice/Vapi chats.
    try {
      sql.insertChat.run({
        company_id     : company.id,
        session_id     : 'wa-' + from.replace(/[^0-9]/g, ''),
        user_message   : body,
        assistant_reply: reply,
        channel        : 'whatsapp',
        latency_ms     : latency,
        user_id        : null,
      });
    } catch (e) { req.log.error('twilio: chat insert failed', { err: e.message }); }

    // Send the reply (best-effort — Twilio will retry the webhook if we 5xx).
    try { await sendWhatsappReply(from, reply); }
    catch (e) { req.log.error('twilio: send reply failed', { err: e.message }); }

    // Twilio expects 200 + empty body (we already replied via the API).
    res.type('text/xml').send('<Response></Response>');
  },
);

// Upsert a single Vapi call object (from the REST list/get API) into our
// calls table. Mirrors the mapping in processVapiEvent but works on the
// call object directly rather than a webhook envelope. Returns the matched
// company id (or null). Used by the backfill endpoint below so calls that
// missed their webhook (e.g. a phone number whose Server URL lacked the
// auth header) still show up in the dashboard.
function upsertVapiCall(v) {
  if (!v || !v.id) return null;
  const assistantId = v.assistantId || v.assistant?.id || null;
  const companyRow = assistantId
    ? db.prepare('SELECT id FROM companies WHERE assistant_id = ?').get(assistantId)
    : null;
  const startedAt = v.startedAt || null;
  const endedAt   = v.endedAt || null;
  const duration  = startedAt && endedAt
    ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000) : null;
  const direction = String(v.type || '').toLowerCase().includes('outbound') ? 'outbound' : 'inbound';
  sql.upsertCall.run({
    id            : v.id,
    company_id    : companyRow?.id || null,
    assistant_id  : assistantId,
    caller_number : v.customer?.number || null,
    duration_sec  : duration,
    started_at    : startedAt,
    ended_at      : endedAt,
    ended_reason  : v.endedReason || null,
    transcript    : v.artifact?.transcript || v.transcript || null,
    summary       : v.analysis?.summary || v.summary || null,
    cost_usd      : v.cost ?? null,
    direction,
  });
  return companyRow?.id || null;
}

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
      const cid = upsertVapiCall(v);
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
app.get('/api/_admin/backup', (req, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
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

// ─── Debug: recent webhook attempts ──────────────────────────────
// Superadmin only. Returns the last 10 webhook attempts (headers
// sanitized) plus the length of VAPI_WEBHOOK_SECRET as configured on
// this server, so the operator can spot mismatches between what Vapi
// is sending and what Railway has in its env vars.
app.get('/api/_debug/recent-webhooks', (req, res) => {
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
    attempts: recentWebhookAttempts.slice().reverse(),
  });
});

// ─── Admin API ───────────────────────────────────────────────────
app.get('/api/companies', (req, res) => {
  // Clients see only their own workspace; superadmins see everything.
  const all = listCompaniesFull();
  const list = req.user.role === 'superadmin'
    ? all
    : all.filter((c) => c.id === req.user.companyId);
  // Per-company stats in a single query.
  const statsRows = db.prepare(`
    SELECT
      c.id AS company_id,
      (SELECT COUNT(DISTINCT session_id) FROM chats WHERE company_id = c.id) AS chats,
      (SELECT COUNT(*) FROM calls WHERE company_id = c.id) AS calls,
      (SELECT MAX(ts) FROM (
        SELECT MAX(created_at) AS ts FROM chats WHERE company_id = c.id
        UNION ALL
        SELECT MAX(created_at) AS ts FROM calls WHERE company_id = c.id
      )) AS last_activity
    FROM companies c
  `).all();
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

app.get('/api/companies/:id', requireCompanyAccess, (req, res) => {
  const c = loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  // Return the raw stored system_prompt and kb_text (not the composed prompt).
  const row = sql.getCompany.get(req.params.id);
  res.json({ ...c, systemPrompt: row.system_prompt, kbText: row.kb_text });
});

app.post('/api/companies', (req, res) => {
  const b = req.body || {};
  // systemPrompt + kbText are legacy — Scenarios replaced them. Kept for old
  // companies that still have them set; we don't require them at creation.
  if (!b.id || !b.name) {
    return res.status(400).json({ error: 'id and name are required' });
  }
  if (!COMPANY_ID_RE.test(b.id)) {
    return res.status(400).json({ error: 'id must be lowercase letters/digits/hyphens (max 40)' });
  }
  if (sql.getCompany.get(b.id)) return res.status(409).json({ error: 'id already exists' });
  sql.insertCompany.run({
    id            : b.id,
    user_id       : req.user.id,
    name          : b.name,
    language      : b.language || 'ar-SA',
    voice_id      : b.voiceId || process.env.ELEVENLABS_VOICE_ID || null,
    phone_number  : b.phoneNumber || null,
    assistant_id  : null,
    system_prompt : b.systemPrompt || '',
    kb_text       : b.kbText || null,
  });
  invalidateCache(b.id);
  audit(req, 'company.create', `companies/${b.id}`, { name: b.name });
  res.status(201).json(loadCompany(b.id));
});

app.patch('/api/companies/:id', requireCompanyAccess, (req, res) => {
  const existing = sql.getCompany.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  sql.updateCompany.run({
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
  res.json(loadCompany(existing.id));
});

app.delete('/api/companies/:id', requireCompanyAdmin, (req, res) => {
  const r = sql.deleteCompany.run(req.params.id);
  invalidateCache(req.params.id);
  audit(req, 'company.delete', `companies/${req.params.id}`);
  res.json({ deleted: r.changes });
});

// Chat sessions + calls per company.
app.get('/api/companies/:id/sessions', requireCompanyAccess, (req, res) => {
  res.json(sql.listSessionsForCompany.all(req.params.id, Number(req.query.limit) || 50));
});

// Verify the session belongs to a company the user can access.
function ensureSessionOwned(req, res, next) {
  const row = db.prepare('SELECT DISTINCT company_id FROM chats WHERE session_id = ?').get(req.params.sessionId);
  if (!row) return res.status(404).json({ error: 'session not found' });
  if (req.user.role === 'superadmin') return next();
  const owns = db.prepare('SELECT 1 FROM companies WHERE id = ? AND user_id = ?').get(row.company_id, req.user.id);
  if (!owns) return res.status(404).json({ error: 'session not found' });
  next();
}

app.get('/api/sessions/:sessionId', ensureSessionOwned, (req, res) => {
  res.json(sql.getSession.all(req.params.sessionId));
});

app.post('/api/sessions/:sessionId/summarize', ensureSessionOwned, async (req, res) => {
  const rows = sql.getSession.all(req.params.sessionId);
  if (!rows.length) return res.status(404).json({ error: 'session not found' });
  const transcript = chatToTranscript(rows);
  const summary = await summarize(transcript);
  if (summary) sql.setSessionSummary.run(summary, req.params.sessionId);
  res.json({ summary });
});

app.get('/api/companies/:id/calls', requireCompanyAccess, (req, res) => {
  res.json(sql.listCallsForCompany.all(req.params.id, Number(req.query.limit) || 50));
});

// Verify the call belongs to a company the user can access.
function ensureCallOwned(req, res, next) {
  const c = sql.getCall.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (req.user.role === 'superadmin') { req._call = c; return next(); }
  if (!c.company_id) return res.status(404).json({ error: 'not found' });
  const owns = db.prepare('SELECT 1 FROM companies WHERE id = ? AND user_id = ?').get(c.company_id, req.user.id);
  if (!owns) return res.status(404).json({ error: 'not found' });
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
      sql.upsertCall.run({
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
      });
      call = sql.getCall.get(call.id);
    } catch (e) {
      req.log.warn('vapi call refresh failed', { err: e.message, callId: call.id });
    }
  }
  res.json(call);
});

app.post('/api/calls/:id/summarize', ensureCallOwned, async (req, res) => {
  const c = req._call;
  const summary = await summarize(c.transcript || '');
  if (summary) sql.setCallSummary.run(summary, c.id);
  res.json({ summary });
});

// Vapi sync: rebuild the Vapi assistant from the company's ACTIVE SCENARIO.
// Everything that matters — system prompt, first message, success criteria,
// variable list — comes from the scenario row. Pressing this button is the
// only thing that should change what callers hear on the phone, so the
// /admin Scenarios page is the only source of truth.
app.post('/api/companies/:id/sync-vapi', requireCompanyAccess, async (req, res) => {
  const c = loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  // Optional override: ?force=1 wipes the stored assistantId before sync.
  // Forces a clean rebuild on Vapi — useful when the user has deleted the
  // assistant from the dashboard and our PATCH would otherwise be silent.
  if (req.query.force === '1' && c.assistantId) {
    db.prepare('UPDATE companies SET assistant_id = NULL WHERE id = ?').run(c.id);
    invalidateCache(c.id);
    Object.assign(c, { assistantId: null });
  }

  const scenarioRow = sql.getActiveScenarioForCompany.get(c.id);
  if (!scenarioRow || !scenarioRow.instruction_prompt) {
    return res.status(409).json({
      error: 'فعّل سيناريو أولاً قبل النشر — الـ Vapi assistant بيتبني من السيناريو النشط.',
      code : 'NO_ACTIVE_SCENARIO',
    });
  }
  const scenario = shapeScenario(scenarioRow);

  // Apply globals to the instruction prompt so {{date}}/{{time}}/{{agent_name}}
  // get sensible defaults baked in. Per-call vars (customer_name, etc) stay
  // as placeholders — Vapi interpolates them from variableValues at call time.
  // The scenario is the SOLE source of truth: no MASTER prefix, no rules
  // appendix. What the user sees in Admin == what Vapi receives (plus the KB
  // dump below). Eliminates the prior duplicate-rules conflict where MASTER
  // and the scenario disagreed on tone/closures and the model wavered.
  let systemContent = fillGlobals(scenario.instructionPrompt, c);

  // Vapi can't query our DB during a call, so any company documents the user
  // expects the agent to know about have to be baked into the system prompt
  // at sync time. Cap the dump so we don't blow past the model's context.
  // Tightened from 30K → 10K: most companies have a few key docs, and a
  // smaller prompt directly reduces per-turn LLM latency.
  const KB_INJECT_CAP = 10000;   // chars
  const chunks = sql.listAllChunksForCompany.all(c.id);
  if (chunks.length) {
    let kbBlock = '\n\n---\n\n## قاعدة معرفة الشركة\n\nاستخدم المعلومات التالية كمصدر حقائق رسمي. لا تختلق أسعاراً أو معلومات غير موجودة هنا:\n\n';
    let used = kbBlock.length;
    for (const ch of chunks) {
      const seg = `\n### ${ch.filename} — مقطع ${ch.chunk_index}\n${ch.text}\n`;
      if (used + seg.length > KB_INJECT_CAP) break;
      kbBlock += seg;
      used += seg.length;
    }
    systemContent += kbBlock;
  }

  // The scenario stays the single source of truth for CONTENT (tone, closing
  // wording, flow). But the `endCall` tool below is attached to every assistant
  // and no business-written scenario references it — so the model speaks a
  // goodbye and never hangs up, looping on each customer "مع السلامة". Append a
  // minimal, purely-technical block that wires the scenario's own closing
  // phrase to the actual hang-up. This is NOT the old "## قواعد المكالمة
  // الصوتية" block (that duplicated tone/closure rules the scenario owns) — it
  // only connects existing behavior to the tool, so it can't conflict.
  systemContent += END_CALL_TOOL_RULE;

  // ELEVENLABS_VOICE_ID is the source of truth for the agent's voice. We
  // ignore company.voice_id here because it gets stamped at seed time and
  // becomes stale the moment you change voices globally. There's no admin
  // UI for per-company voice overrides, so deferring to env is simplest.
  const voiceId = process.env.ELEVENLABS_VOICE_ID || c.voiceId;

  const cfg = {
    name: `smart-assistant:${c.id}`,
    model: {
      // gpt-4o-mini (Vapi cluster routing): lowest-latency OpenAI option that
      // still handles Saudi Arabic + instruction-following cleanly. 0.6 temp
      // + 200 maxTokens balance brevity with natural flow.
      provider   : 'openai', model: 'gpt-4o-mini', temperature: 0.6, maxTokens: 200,
      // endCall tool lets the model actually hang up by calling a function —
      // without this, writing "end call" in the prompt does nothing because
      // there's no tool to invoke. The scenario prompt instructs the agent
      // to use this tool when the conversation is done.
      tools      : [{ type: 'endCall' }],
      messages   : [{ role: 'system', content: systemContent }],
    },
    voice: {
      provider: '11labs', voiceId,
      model: 'eleven_flash_v2_5',
      // stability 0.55 → 0.45: more variation across syllables, less of a
      // monotone "report" cadence. similarityBoost 0.8 keeps the speaker
      // identity tight despite the wider variation.
      stability: 0.45, similarityBoost: 0.8,
      useSpeakerBoost: true,
      // 4 (max) streamed audio in tiny chunks → sounded chopped, "word by
      // word". 3 keeps the start-time low but joins phonemes more smoothly.
      optimizeStreamingLatency: 3,
    },
    // Azure ar-SA is specifically tuned for Saudi Arabic — better word
    // accuracy on Saudi vocab (شقق/مكتب/إيجار) than the multilingual model.
    transcriber: { provider: 'azure', language: 'ar-SA' },
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
      idleTimeoutSeconds: 7,
    },
    silenceTimeoutSeconds: 30,
    // 0.4 → 0.3s: the agent jumps in faster after the user stops talking.
    // smartEndpointingEnabled tells Vapi to detect real end-of-speech via
    // LiveKit's ML model rather than relying on raw silence.
    startSpeakingPlan: { waitSeconds: 0.3, smartEndpointingEnabled: 'livekit' },
    // Aggressive interrupt: stop the agent the instant the user starts
    // speaking. numWords 1 (vs 2) means a single syllable triggers a stop;
    // voiceSeconds 0.1 (vs 0.2) shortens the voice-activity confirmation;
    // backoffSeconds 0.5 (vs 1.0) means it doesn't sulk for a full second
    // after being cut off.
    stopSpeakingPlan : { numWords: 1, voiceSeconds: 0.1, backoffSeconds: 0.5 },
  };

  const headers = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' };
  const vapiOpts = { headers, timeout: VAPI_TIMEOUT_MS };
  try {
    let assistantId = c.assistantId;

    // If we have a saved id, confirm it still exists on Vapi. The user could
    // have deleted it from the Vapi dashboard, leaving our DB pointing at a
    // dead UUID. PATCH would silently 404 and the user would think their
    // config changes "aren't reaching Vapi". Verify first and clear if dead.
    if (assistantId) {
      try {
        await axios.get(`https://api.vapi.ai/assistant/${assistantId}`, vapiOpts);
      } catch (e) {
        if (e.response?.status === 404) {
          req.log.warn('vapi sync: stored assistant gone, recreating', { assistantId, companyId: c.id });
          assistantId = null;
        } else {
          throw e;
        }
      }
    }

    // Still no id: try to find an existing one by name (lets us recover after
    // a manual rename or a DB wipe), otherwise create from scratch.
    if (!assistantId) {
      const list = (await axios.get('https://api.vapi.ai/assistant', vapiOpts)).data || [];
      const found = list.find((a) => a.name === cfg.name);
      assistantId = found?.id || null;
    }
    if (assistantId) {
      await axios.patch(`https://api.vapi.ai/assistant/${assistantId}`, cfg, vapiOpts);
    } else {
      const r = await axios.post('https://api.vapi.ai/assistant', cfg, vapiOpts);
      assistantId = r.data.id;
    }
    // Stamp last_synced_at so the UI can show "unpublished changes" when
    // the active scenario gets edited after a sync.
    db.prepare(`
      UPDATE companies
         SET assistant_id    = ?,
             last_synced_at  = datetime('now'),
             updated_at      = datetime('now')
       WHERE id = ?
    `).run(assistantId, c.id);
    invalidateCache(c.id);
    res.json({ assistantId, scenarioId: scenario.id, scenarioName: scenario.name });
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
  const c = loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!c.assistantId) return res.status(400).json({ error: 'sync to Vapi first' });

  const headers = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' };
  const vapiOpts = { headers, timeout: VAPI_TIMEOUT_MS };
  const phoneId = process.env.VAPI_PHONE_NUMBER_ID;
  try {
    const r = await axios.patch(`https://api.vapi.ai/phone-number/${phoneId}`, { assistantId: c.assistantId }, vapiOpts);
    const newNumber = r.data.number;
    // Vapi succeeded — now reflect the move in DB atomically.
    db.transaction(() => {
      db.prepare('UPDATE companies SET phone_number = NULL WHERE phone_number = ?').run(newNumber);
      db.prepare("UPDATE companies SET phone_number = ?, updated_at = datetime('now') WHERE id = ?").run(newNumber, c.id);
    })();
    invalidateCache();
    audit(req, 'vapi.phone_bind', `companies/${c.id}`, { phoneNumber: newNumber });
    res.json({ phoneNumber: newNumber, assistantId: c.assistantId });
  } catch (e) {
    req.log.error('phone bind error', { err: e.response?.data || e.message, companyId: c.id });
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ─── RAG: documents CRUD + retrieval test ────────────────────────
app.post('/api/companies/:id/documents', requireCompanyAccess, upload.single('file'), async (req, res) => {
  const c = loadCompany(req.params.id);
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
    });
  } catch (e) {
    req.log.error('ingest error', { err: e.message, companyId: c.id });
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/companies/:id/documents', requireCompanyAccess, (req, res) => {
  res.json(sql.listDocuments.all(req.params.id));
});

app.delete('/api/companies/:id/documents/:docId', requireCompanyAccess, (req, res) => {
  const doc = sql.getDocument.get(req.params.docId);
  if (!doc || doc.company_id !== req.params.id) {
    return res.status(404).json({ error: 'document not found' });
  }
  // Soft-delete the document row (preserves raw_text for forensics) and hard-
  // delete the searchable chunks so retrieval can't surface it any more.
  db.transaction(() => {
    sql.deleteDocument.run(req.params.docId);
    sql.purgeDocumentChunks.run(req.params.docId);
  })();
  audit(req, 'document.delete', `companies/${req.params.id}/documents/${req.params.docId}`, { filename: doc.filename });
  res.json({ deleted: 1 });
});

// Download the original document if available, otherwise fallback to extracted text.
app.get('/api/companies/:id/documents/:docId/download', requireCompanyAccess, (req, res) => {
  const doc = sql.getDocument.get(req.params.docId);
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

app.get('/api/dashboard', (req, res) => {
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
  const stat = (range) => {
    const a = args(range);
    const calls    = sql.countCallsInRange.get(a).n || 0;
    const avgRow   = sql.avgCallDurationInRange.get(a);
    const avgDur   = Math.round(avgRow?.avg_dur || 0);
    const okRow    = sql.callSuccessRateInRange.get(a);
    const ok       = okRow?.ok || 0;
    const total    = okRow?.total || 0;
    const success  = total ? ok / total : 0;
    const chats    = sql.countChatSessionsInRange.get(a).n || 0;
    return { calls, avgDur, success, chats };
  };
  const current  = stat(cur);
  const previous = stat(prev);

  // 24-hour chart for the current period. We bucket on hour-of-day (00..23),
  // not on calendar date — for a "Today" window that maps to a real timeline,
  // for "This Week/Month" it shows when in the day activity tends to land.
  const a = args(cur);
  const callRows = sql.callsPerHourInRange.all(a);
  const inboundByHour  = new Map();
  const outboundByHour = new Map();
  for (const r of callRows) {
    const map = r.direction === 'outbound' ? outboundByHour : inboundByHour;
    map.set(r.hour, (map.get(r.hour) || 0) + r.n);
  }
  const chatsByHour = new Map(sql.chatsPerHourInRange.all(a).map((r) => [r.hour, r.n]));
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

  const scenarios = sql.countActiveCompanies.get({ company_id }).n || 0;

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
app.get('/api/conversations', (req, res) => {
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
    ? db.prepare('SELECT id, name FROM companies WHERE id = ?').all(scopedCompany)
    : db.prepare('SELECT id, name FROM companies').all();
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
  const chats = typeFilter === 'voice' ? [] : db.prepare(`
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
    GROUP BY session_id
  `).all(...ids, ...timeArgs);

  // Calls.
  const calls = typeFilter === 'chat' ? [] : db.prepare(`
    SELECT id, company_id, created_at AS ts, caller_number, duration_sec, ended_reason, summary, direction
    FROM calls
    WHERE company_id IN (${inPlaceholders}) ${timeClause}
  `).all(...ids, ...timeArgs);

  // Hydrate user emails for chat rows in one round-trip.
  const userIds = [...new Set(chats.map((c) => c.user_id).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length) {
    const ph = userIds.map(() => '?').join(',');
    db.prepare(`SELECT id, email FROM users WHERE id IN (${ph})`).all(...userIds)
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
      phoneNumber : c.caller_number || null,
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
    items = items.filter((i) =>
         (i.phoneNumber || '').toLowerCase().includes(search)
      || (i.user        || '').toLowerCase().includes(search)
      || (i.summary     || '').toLowerCase().includes(search)
      || (i.companyName || '').toLowerCase().includes(search)
    );
  }

  items.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const total = items.length;
  const start = (page - 1) * limit;
  const slice = items.slice(start, start + limit);

  res.json({ items: slice, total, page, limit });
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
const activateExclusively = db.transaction((companyId, scenarioId) => {
  sql.deactivateAllScenariosForCompany.run({ company_id: companyId, except_id: scenarioId });
  sql.setScenarioActive.run({ id: scenarioId, is_active: 1 });
});

// Returns the currently-active scenario for a company (or null). The
// Playground uses this to render input-data fields, prefill the greeting,
// and know whether to surface an "Activate a scenario first" empty state.
app.get('/api/companies/:id/scenarios/active', requireCompanyAccess, (req, res) => {
  const row = sql.getActiveScenarioForCompany.get(req.params.id);
  res.json(row ? shapeScenario(row) : null);
});

app.get('/api/companies/:id/scenarios', requireCompanyAccess, (req, res) => {
  const tab = String(req.query.tab || 'active');
  const rows = tab === 'deleted'
    ? sql.listDeletedScenarios.all(req.params.id)
    : sql.listScenarios.all(req.params.id);
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

app.get('/api/scenarios/:id', requireAuth, (req, res) => {
  const row = sql.getScenario.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== row.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json(shapeScenario(row));
});

app.post('/api/companies/:id/scenarios', requireCompanyAccess, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 200);
  const instructionPrompt = String(b.instructionPrompt || '').trim();
  if (!name || !instructionPrompt) {
    return res.status(400).json({ error: 'name and instructionPrompt are required' });
  }
  const firstMessage        = String(b.firstMessage || '').slice(0, 2000);
  const firstMessageInbound = String(b.firstMessageInbound || '').slice(0, 2000);
  const criteria     = Array.isArray(b.successCriteria) ? b.successCriteria : [];
  const variables    = detectVariables(b.variables, firstMessage, firstMessageInbound, instructionPrompt);
  const kbIds        = Array.isArray(b.knowledgeBaseIds) ? b.knowledgeBaseIds : [];
  const wantActive = b.isActive !== false;
  const r = sql.insertScenario.run({
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
  if (wantActive) activateExclusively(req.params.id, r.lastInsertRowid);
  audit(req, 'scenario.create', `scenarios/${r.lastInsertRowid}`, { name });
  res.status(201).json({
    ...shapeScenario(sql.getScenario.get(r.lastInsertRowid)),
    warnings: lintScenario(instructionPrompt),
  });
});

app.patch('/api/scenarios/:id', requireAuth, (req, res) => {
  const existing = sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  const b = req.body || {};
  const firstMessage         = b.firstMessage         !== undefined ? String(b.firstMessage).slice(0, 2000)         : existing.first_message;
  const firstMessageInbound  = b.firstMessageInbound  !== undefined ? String(b.firstMessageInbound).slice(0, 2000)  : (existing.first_message_inbound || '');
  const instructionPrompt    = b.instructionPrompt    !== undefined ? String(b.instructionPrompt).slice(0, 30000)   : existing.instruction_prompt;
  const prevVars             = parseVariables(existing.variables);
  const variables            = b.variables !== undefined
    ? (Array.isArray(b.variables) ? b.variables : detectVariables(prevVars, firstMessage, firstMessageInbound, instructionPrompt))
    : detectVariables(prevVars, firstMessage, firstMessageInbound, instructionPrompt);
  const nextIsActive = b.isActive !== undefined ? (b.isActive ? 1 : 0) : existing.is_active;
  sql.updateScenario.run({
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
  if (nextIsActive === 1) activateExclusively(existing.company_id, existing.id);
  audit(req, 'scenario.update', `scenarios/${existing.id}`, Object.keys(b));
  res.json({
    ...shapeScenario(sql.getScenario.get(existing.id)),
    warnings: lintScenario(instructionPrompt),
  });
});

// Live lint — the editor calls this (debounced) so a company sees TTS/prompt
// problems as it types, before saving or publishing. Stateless + auth-gated.
app.post('/api/scenarios/lint', requireAuth, (req, res) => {
  const text = String(req.body?.text || '').slice(0, 30000);
  res.json({ warnings: lintScenario(text) });
});

app.post('/api/scenarios/:id/activate', requireAuth, (req, res) => {
  const existing = sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  const isActive = req.body?.isActive === false ? 0 : 1;
  if (isActive) {
    // Activating: this scenario becomes the sole active one for the company.
    activateExclusively(existing.company_id, existing.id);
  } else {
    sql.setScenarioActive.run({ id: existing.id, is_active: 0 });
  }
  audit(req, isActive ? 'scenario.activate' : 'scenario.deactivate', `scenarios/${existing.id}`);
  res.json({ id: existing.id, isActive: !!isActive });
});

app.delete('/api/scenarios/:id', requireAuth, (req, res) => {
  const existing = sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  sql.softDeleteScenario.run(existing.id);
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

    const r = sql.insertScenario.run({
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
    activateExclusively(req.params.id, r.lastInsertRowid);
    audit(req, 'scenario.generate', `scenarios/${r.lastInsertRowid}`, { name });
    res.status(201).json(shapeScenario(sql.getScenario.get(r.lastInsertRowid)));
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
  const c = loadCompany(req.params.id);
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
        score     : Number(ch.score.toFixed(4)),
        preview   : ch.text.slice(0, 280) + (ch.text.length > 280 ? '...' : ''),
        text      : ch.text,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
  logger.info('server started', { port: Number(PORT), adminUrl: `http://localhost:${PORT}/admin/` });
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
  httpServer.close((err) => {
    if (err) logger.error('http close error', { err: err.message });
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { logger.error('wal checkpoint failed', { err: e.message }); }
    try { db.close(); } catch (e) { logger.error('db close failed', { err: e.message }); }
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
