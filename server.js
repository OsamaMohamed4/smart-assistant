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
const { loadCompany, listCompaniesFull, invalidateCache, buildSystemPromptWithRAG } = require('./companies');
const { summarize, chatToTranscript } = require('./summarize');
const { ingestDocument, retrieve } = require('./lib/rag');
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
// from same origin (no inline JS, no eval). `connect-src` covers fetch/XHR.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      scriptSrcAttr:  ["'none'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", "data:", "blob:"],
      fontSrc:        ["'self'", "data:"],
      connectSrc:     ["'self'"],
      mediaSrc:       ["'self'", "blob:"],
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
  return { company, message, history };
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

async function askGPT(company, message, history) {
  const systemContent = await buildSystemPromptWithRAG(company, message);
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
    const r = await askGPT(ctx.company, ctx.message, ctx.history);
    sql.insertChat.run({
      company_id: ctx.company.id, session_id: sessionId,
      user_message: ctx.message, assistant_reply: r.reply,
      channel: 'text', latency_ms: r.ms,
      user_id: req.user.id,
    });
    res.setHeader('X-Session-Id', sessionId);
    res.json({ company: ctx.company.name, sessionId, reply: r.reply, ms: r.ms, usage: r.usage });
  } catch (err) {
    req.log.error('GPT error', { err: err.message, companyId: ctx.company.id });
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat-voice', chatLimiter, requireAuth, async (req, res) => {
  const ctx = resolveCompany(req, res);
  if (!ctx) return;
  if (!canChatWithCompany(req.user, ctx.company.id)) {
    return res.status(403).json({ error: 'لا تملك صلاحية محادثة هذه الشركة' });
  }
  const sessionId = getOrMakeSessionId(req);
  const voiceId = ctx.company.voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) return res.status(500).json({ error: 'No voiceId configured' });

  try {
    // Enforce per-company per-day TTS character budget BEFORE we call ElevenLabs.
    const today = todayUtc();
    const used = sql.getUsage.get(ctx.company.id, today, 'tts_chars')?.amount || 0;
    if (used >= TTS_DAILY_CAP_CHARS) {
      return res.status(429).json({ error: 'تم استنفاد حصة الصوت اليومية لهذه الشركة' });
    }

    const gpt = await askGPT(ctx.company, ctx.message, ctx.history);
    sql.insertChat.run({
      company_id: ctx.company.id, session_id: sessionId,
      user_message: ctx.message, assistant_reply: gpt.reply,
      channel: 'voice', latency_ms: gpt.ms,
      user_id: req.user.id,
    });

    // Record the TTS spend optimistically (idempotent on hash collision = no-op).
    sql.bumpUsage.run({
      company_id: ctx.company.id, day: today, kind: 'tts_chars',
      amount    : (gpt.reply || '').length,
    });

    const tts = await ttsStream(gpt.reply, voiceId);
    // Bound the reply that travels via response header. Replies are already
    // capped by max_tokens=300 (≈1200 chars), so base64 stays well under 8KB,
    // but we hard-cap defensively against future limit changes.
    const replyB64 = Buffer.from(String(gpt.reply || '').slice(0, 4000), 'utf8').toString('base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Company', encodeURIComponent(ctx.company.name));
    res.setHeader('X-Reply-Text', replyB64);
    res.setHeader('X-Gpt-Ms', String(gpt.ms));
    res.setHeader('X-Session-Id', sessionId);

    const t1 = Date.now();
    let firstChunkMs = null;
    tts.data.on('data', () => {
      if (!firstChunkMs) {
        firstChunkMs = Date.now() - t1;
        res.setHeader('X-Tts-First-Chunk-Ms', String(firstChunkMs));
      }
    });
    tts.data.on('error', (err) => {
      req.log.error('TTS stream error', { err: err.message });
      if (!res.headersSent) res.status(502).json({ error: 'TTS stream failed' });
    });
    tts.data.pipe(res);
  } catch (err) {
    req.log.error('chat-voice error', { err: err.response?.data || err.message });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Vapi webhook ────────────────────────────────────────────────
// Verify the request was sent by Vapi using HMAC-SHA256 over the raw body.
// Vapi computes: hex(hmacSha256(VAPI_WEBHOOK_SECRET, rawRequestBody)) and
// sends it in `x-vapi-signature`. We recompute and timing-safe compare.
function verifyVapiSignature(req) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    // Unset secret is fatal in production; tolerated only in development.
    return process.env.NODE_ENV !== 'production';
  }
  const sig = req.get('x-vapi-signature') || '';
  if (!sig || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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
    });

    if (transcript && (!msg.summary || msg.summary.length < 20)) {
      const ours = await summarize(transcript);
      if (ours) sql.setCallSummary.run(ours, call.id);
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
  if (!verifyVapiSignature(req)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

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
  if (!b.id || !b.name || !b.systemPrompt) {
    return res.status(400).json({ error: 'id, name, systemPrompt are required' });
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
    system_prompt : b.systemPrompt,
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

app.get('/api/calls/:id', ensureCallOwned, (req, res) => {
  res.json(req._call);
});

app.post('/api/calls/:id/summarize', ensureCallOwned, async (req, res) => {
  const c = req._call;
  const summary = await summarize(c.transcript || '');
  if (summary) sql.setCallSummary.run(summary, c.id);
  res.json({ summary });
});

// Vapi sync: create or patch the assistant from the company's current DB state.
app.post('/api/companies/:id/sync-vapi', requireCompanyAccess, async (req, res) => {
  const c = loadCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const cfg = {
    name: `smart-assistant:${c.id}`,
    model: {
      provider: 'openai', model: 'gpt-4o-mini', temperature: 0.7, maxTokens: 250,
      messages: [{ role: 'system', content: c.systemPrompt }],
    },
    voice: {
      provider: '11labs', voiceId: c.voiceId || process.env.ELEVENLABS_VOICE_ID,
      model: 'eleven_flash_v2_5', stability: 0.55, similarityBoost: 0.8,
      useSpeakerBoost: true, optimizeStreamingLatency: 4,
    },
    transcriber: { provider: 'azure', language: 'ar-SA' },
    firstMessage: `حياك الله في ${c.name}، أنا المساعد الذكي. كيف أقدر أخدمك؟`,
    firstMessageMode: 'assistant-speaks-first',
    backgroundDenoisingEnabled: true,
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    endCallPhrases: ['شكراً مع السلامة', 'باي باي', 'goodbye'],
    startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingEnabled: 'livekit' },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1.0 },
  };

  const headers = { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' };
  const vapiOpts = { headers, timeout: VAPI_TIMEOUT_MS };
  try {
    let assistantId = c.assistantId;
    if (!assistantId) {
      // No saved id — look up by name in Vapi.
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
    if (assistantId !== c.assistantId) {
      db.prepare('UPDATE companies SET assistant_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(assistantId, c.id);
      invalidateCache(c.id);
    }
    res.json({ assistantId });
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

  try {
    const result = await ingestDocument({
      companyId: c.id,
      filename : req.file.originalname,
      mime     : req.file.mimetype,
      buffer   : req.file.buffer,
    });
    res.status(201).json({
      documentId  : result.documentId,
      filename    : req.file.originalname,
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
  const callsByHour = new Map(sql.callsPerHourInRange.all(a).map((r) => [r.hour, r.n]));
  const chatsByHour = new Map(sql.chatsPerHourInRange.all(a).map((r) => [r.hour, r.n]));
  const chart = [];
  for (let h = 0; h < 24; h++) {
    const key = String(h).padStart(2, '0');
    chart.push({
      hour    : key,
      inbound : callsByHour.get(key) || 0,
      // No outbound-call infrastructure yet — slot reserved so the chart UX
      // stays stable when batch-calls ships.
      outbound: 0,
      chats   : chatsByHour.get(key) || 0,
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
    SELECT id, company_id, created_at AS ts, caller_number, duration_sec, ended_reason, summary
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
    return {
      id          : `call-${c.id}`,
      callId      : c.id,
      type        : 'voice',
      direction   : 'inbound',
      timestamp   : c.ts,
      user        : null,
      phoneNumber : c.caller_number || null,
      companyId   : c.company_id,
      companyName : companyMap.get(c.company_id) || c.company_id,
      scenario    : companyMap.get(c.company_id) || c.company_id,
      status      : ok ? 'completed' : 'failed',
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
    id                : row.id,
    companyId         : row.company_id,
    name              : row.name,
    description       : row.description || '',
    firstMessage      : row.first_message || '',
    instructionPrompt : row.instruction_prompt || '',
    successCriteria   : parseCriteria(row.success_criteria),
    variables         : parseVariables(row.variables),
    isActive          : !!row.is_active,
    language          : row.language || 'ar',
    knowledgeBaseIds  : parseVariables(row.knowledge_base_ids),
    createdAt         : row.created_at,
    updatedAt         : row.updated_at,
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
  const firstMessage = String(b.firstMessage || '').slice(0, 2000);
  const criteria     = Array.isArray(b.successCriteria) ? b.successCriteria : [];
  const variables    = detectVariables(b.variables, firstMessage, instructionPrompt);
  const kbIds        = Array.isArray(b.knowledgeBaseIds) ? b.knowledgeBaseIds : [];
  const r = sql.insertScenario.run({
    company_id         : req.params.id,
    name,
    description        : String(b.description || '').slice(0, 4000),
    first_message      : firstMessage,
    instruction_prompt : instructionPrompt.slice(0, 30000),
    success_criteria   : JSON.stringify(criteria),
    variables          : JSON.stringify(variables),
    is_active          : b.isActive === false ? 0 : 1,
    language           : String(b.language || 'ar').slice(0, 8),
    knowledge_base_ids : JSON.stringify(kbIds),
  });
  audit(req, 'scenario.create', `scenarios/${r.lastInsertRowid}`, { name });
  res.status(201).json(shapeScenario(sql.getScenario.get(r.lastInsertRowid)));
});

app.patch('/api/scenarios/:id', requireAuth, (req, res) => {
  const existing = sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  const b = req.body || {};
  const firstMessage      = b.firstMessage      !== undefined ? String(b.firstMessage).slice(0, 2000) : existing.first_message;
  const instructionPrompt = b.instructionPrompt !== undefined ? String(b.instructionPrompt).slice(0, 30000) : existing.instruction_prompt;
  const prevVars          = parseVariables(existing.variables);
  const variables         = b.variables !== undefined
    ? (Array.isArray(b.variables) ? b.variables : detectVariables(prevVars, firstMessage, instructionPrompt))
    : detectVariables(prevVars, firstMessage, instructionPrompt);
  sql.updateScenario.run({
    id                 : existing.id,
    name               : b.name             !== undefined ? String(b.name).trim().slice(0, 200) : existing.name,
    description        : b.description      !== undefined ? String(b.description).slice(0, 4000) : (existing.description || ''),
    first_message      : firstMessage,
    instruction_prompt : instructionPrompt,
    success_criteria   : b.successCriteria !== undefined ? JSON.stringify(b.successCriteria) : (existing.success_criteria || '[]'),
    variables          : JSON.stringify(variables),
    is_active          : b.isActive !== undefined ? (b.isActive ? 1 : 0) : existing.is_active,
    language           : b.language         !== undefined ? String(b.language).slice(0, 8) : (existing.language || 'ar'),
    knowledge_base_ids : b.knowledgeBaseIds !== undefined
      ? JSON.stringify(b.knowledgeBaseIds)
      : (existing.knowledge_base_ids || '[]'),
  });
  audit(req, 'scenario.update', `scenarios/${existing.id}`, Object.keys(b));
  res.json(shapeScenario(sql.getScenario.get(existing.id)));
});

app.post('/api/scenarios/:id/activate', requireAuth, (req, res) => {
  const existing = sql.getScenario.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'superadmin' && req.user.companyId !== existing.company_id) {
    return res.status(404).json({ error: 'not found' });
  }
  const isActive = req.body?.isActive === false ? 0 : 1;
  sql.setScenarioActive.run({ id: existing.id, is_active: isActive });
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
2. رسالة افتتاحية بالعربية باستخدام المتغيرات {{customer_name}} و {{agent_name}}
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
    const name              = String(parsed.name              || 'Generated Scenario').slice(0, 200);
    const firstMessage      = String(parsed.first_message     || '').slice(0, 2000);
    const instructionPrompt = String(parsed.instruction_prompt|| '').slice(0, 30000);
    const criteriaArr       = Array.isArray(parsed.success_criteria) ? parsed.success_criteria : [];
    const successCriteria   = criteriaArr.slice(0, 6).map((t, i) => ({
      text: String(t).slice(0, 500),
      primary: i === 0,
    }));
    const variables = detectVariables([], firstMessage, instructionPrompt);

    const r = sql.insertScenario.run({
      company_id         : req.params.id,
      name,
      description,
      first_message      : firstMessage,
      instruction_prompt : instructionPrompt,
      success_criteria   : JSON.stringify(successCriteria),
      variables          : JSON.stringify(variables),
      is_active          : 1,
      language,
      knowledge_base_ids : '[]',
    });
    audit(req, 'scenario.generate', `scenarios/${r.lastInsertRowid}`, { name });
    res.status(201).json(shapeScenario(sql.getScenario.get(r.lastInsertRowid)));
  } catch (e) {
    req.log.error('scenario gen error', { err: e.message });
    res.status(502).json({ error: e.message || 'AI generation failed' });
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
