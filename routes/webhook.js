// Vapi webhook endpoint: signature verification, debug capture ring buffer,
// store-first-then-process inbox handling. Mounted at /webhook.
const express = require('express');
const crypto = require('crypto');
const { sql } = require('../db');
const { logger } = require('../lib/logger');
const { processVapiEvent, drainWebhookInbox } = require('../services/call-events');

const router = express.Router();

// ─── Debug capture ────────────────────────────────────────────────
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

function getRecentWebhookAttempts() {
  return recentWebhookAttempts.slice().reverse();
}

// ─── Signature verification ──────────────────────────────────────
// Vapi supports several auth modes configured per organization/phone number:
//   1. Custom HTTP Headers — Vapi forwards exactly what you configured.
//      Common names: VAPI_WEBHOOK_SECRET (the one we use), X-Vapi-Secret,
//      Authorization: Bearer ...
//   2. Legacy HMAC-SHA256 over the raw body, sent in `x-vapi-signature`.
// We accept any of the above so the operator can pick whichever header
// survives their reverse-proxy filtering. timingSafeEqual on every candidate.
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
    req.get('x-secret-webhook'),   // tolerate common alternate names
    req.get('x-webhook-secret'),
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

// ─── POST /webhook/vapi ──────────────────────────────────────────
router.post('/vapi', async (req, res) => {
  const captured = captureWebhookAttempt(req);
  if (!verifyVapiSignature(req)) {
    captured.verified = false;
    req.log.warn('vapi webhook: signature verification failed', captured);
    return res.status(401).json({ error: 'invalid signature' });
  }
  captured.verified = true;

  const msg = req.body?.message;

  // 1. Persist the raw payload before doing anything else. If processing or
  // the process itself dies, the event survives in the inbox for retry.
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

  // 4. Best-effort: pick up older failures while we're already here.
  try { await drainWebhookInbox(5); } catch (e) { req.log.error('drain failed', { err: e.message }); }
});

module.exports = { router, getRecentWebhookAttempts, verifyVapiSignature };
