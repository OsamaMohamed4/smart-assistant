// Provider webhook surface. Mounted at /webhook.
//
//   POST /webhook/elevenlabs           post-call events (HMAC-signed)
//   POST /webhook/elevenlabs/init      conversation-initiation personalization
//   POST /webhook/elevenlabs/tools/kb  in-call knowledge-base search tool
//
// The three have DIFFERENT trust models and are authenticated differently:
//   - post-call is signed by the provider (elevenlabs-signature HMAC);
//   - the tool endpoint carries a per-company token we minted at sync time;
//   - the init endpoint is signed like post-call when a secret is configured,
//     and additionally only ever answers with data for a company resolved from
//     the DIALLED number — never from anything in the request body alone.
const express = require('express');
const { sql } = require('../db');
const { logger } = require('../lib/logger');
const { processCallEvent, drainWebhookInbox } = require('../services/call-events');
const { dailyCap, checkAndBumpUsage } = require('../services/usage');
const { featureEnabled } = require('../services/features/store');
const voice = require('../services/voice');

const router = express.Router();
const elevenlabs = voice.DRIVERS.elevenlabs;

// ─── Debug capture ────────────────────────────────────────────────
// In-memory ring buffer of the last 10 webhook attempts so the operator can
// hit /api/_debug/recent-webhooks and see EXACTLY what is arriving when
// verification keeps failing. Values longer than 24 chars are masked (first 8
// + last 4 + length) so secrets never leak verbatim into the UI.
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
    path    : req.path,
    bodyType: req.body?.type || null,
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

// ─── Inbox key ────────────────────────────────────────────────────
// The inbox is UNIQUE(provider, event_id) with ON CONFLICT DO NOTHING, and
// post_call_transcription and post_call_audio carry the SAME conversation_id.
// Keyed on the conversation alone, whichever of the two arrived second was
// silently discarded — never stored, never retryable — so a crash while
// processing it lost that event for good, transcript included. Scoping the key
// by event type keeps each type idempotent on its own without letting one type
// mask another.
//
// A payload with no conversation_id yields null, which SQL treats as distinct
// from every other null: such events are always stored, never deduplicated.
// That is the safe direction — a duplicate row is recoverable, a dropped one is
// not.
function webhookEventId(payload) {
  const conversationId = payload?.data?.conversation_id || null;
  if (!conversationId) return null;
  return `${payload?.type || 'unknown'}:${conversationId}`;
}

// ─── POST /webhook/elevenlabs ────────────────────────────────────
// Post-call events: post_call_transcription, post_call_audio,
// call_initiation_failure.
router.post('/elevenlabs', async (req, res) => {
  const captured = captureWebhookAttempt(req);
  if (!elevenlabs.verifyWebhook(req)) {
    captured.verified = false;
    req.log.warn('elevenlabs webhook: signature verification failed', captured);
    return res.status(401).json({ error: 'invalid signature' });
  }
  captured.verified = true;

  const payload = req.body || {};
  const eventType = payload?.type || null;
  const eventId = webhookEventId(payload);

  // 1. Persist the raw payload before doing anything else. If processing — or
  //    the process itself — dies, the event survives in the inbox for retry.
  let row;
  try {
    const result = await sql.insertWebhookEvent.run({
      provider  : elevenlabs.name,
      event_id  : eventId,
      event_type: eventType,
      raw_body  : req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(payload),
    });
    row = result.changes ? result.lastInsertRowid : null;
  } catch (e) {
    req.log.error('webhook inbox insert failed', { err: e.message });
  }

  // 2. Ack immediately. The provider treats a non-200 as a failed delivery, and
  //    we have already durably stored the payload.
  res.json({ ok: true });

  // 3. Process inline, then drain any stragglers from prior failures.
  try {
    const ev = elevenlabs.normalizeEvent(payload);
    if (ev) await processCallEvent(ev);
    if (row) await sql.markWebhookProcessed.run(row);
  } catch (e) {
    if (row) await sql.markWebhookFailed.run(e.message?.slice(0, 500) || 'unknown', row);
    req.log.error('elevenlabs webhook processing failed', { err: e.message });
  }

  try { await drainWebhookInbox(5); } catch (e) { req.log.error('drain failed', { err: e.message }); }
});

// ─── POST /webhook/elevenlabs/init ───────────────────────────────
// Conversation-initiation webhook. Fires on inbound SIP calls before audio
// connects; whatever we return personalizes that single conversation.
//
// Tenant safety: the company is resolved from `called_number` (our 3CX DID,
// set by the carrier) and `agent_id` (set by the provider). `caller_id` — the
// one field an attacker controls, via caller-ID spoofing — is passed to the
// agent as a variable but NEVER used to choose a tenant.
router.post('/elevenlabs/init', async (req, res) => {
  const captured = captureWebhookAttempt(req);
  // NOT HMAC-signed by the provider — see verifyInitWebhook. Authentication is
  // a constant secret header we register in the webhook's `request_headers`; a
  // real signature is still honoured if one ever arrives.
  if (!elevenlabs.verifyInitWebhook(req)) {
    captured.verified = false;
    req.log.warn('elevenlabs init webhook: signature verification failed', captured);
    return res.status(401).json({ error: 'invalid signature' });
  }
  captured.verified = true;

  const b = req.body || {};
  const calledNumber = String(b.called_number || '').trim();
  const agentId      = String(b.agent_id || '').trim();
  const callerId     = String(b.caller_id || '').trim();

  // Same uniqueness rule as the post-call path: if two companies ever claim one
  // identifier the call is left unpersonalized rather than handed another
  // tenant's name and context.
  let companyId = null;
  try {
    companyId = await elevenlabs.uniqueCompanyId(
      sql.companyByAgentId, agentId, 'elevenlabs_agent_id', req.log,
    );
    if (!companyId) {
      companyId = await elevenlabs.uniqueCompanyId(
        sql.companyByPhoneNumber, calledNumber, 'phone_number', req.log,
      );
    }
  } catch (e) {
    req.log.error('init webhook: company lookup failed', { err: e.message });
  }

  if (!companyId) {
    // Answer with a well-formed empty payload rather than an error: a 4xx here
    // would drop a real customer's call. The agent then runs on its own
    // configured defaults, which are already correct for whichever company
    // owns the agent.
    req.log.warn('init webhook: no company matched', { agentId, calledNumber });
    return res.json({ type: 'conversation_initiation_client_data', dynamic_variables: {} });
  }

  let company = null;
  try {
    const { loadCompany } = require('../companies');
    company = await loadCompany(companyId);
  } catch (e) {
    req.log.error('init webhook: company load failed', { err: e.message, companyId });
  }

  req.log.info('init webhook handled', { companyId, agentId, calledNumber: !!calledNumber });

  // Only variables the scenario can reference. No secrets, no KB, no prompt —
  // the agent already carries those; this is per-call context only.
  res.json({
    type: 'conversation_initiation_client_data',
    dynamic_variables: {
      company_id  : companyId,
      company_name: company?.name || '',
      caller_number: callerId,
    },
  });
});

// ─── POST /webhook/elevenlabs/tools/kb ───────────────────────────
// In-call knowledge-base search. The agent calls this synchronously and waits,
// so it answers directly instead of going through the inbox.
//
// Authentication is the X-Company-Token header minted per company at sync time
// and stored by the provider. The company id comes from THAT token, never from
// the request body — the body's `query` is written by the language model and
// must be treated as hostile input.
// What the agent hears when the knowledge base cannot answer. Deliberately the
// same sentence for "search failed" and "budget exhausted": the caller is a
// customer on a phone line, and the difference is an operations detail that
// belongs in our logs, not in the conversation.
const KB_UNAVAILABLE = 'تعذر البحث في قاعدة المعرفة حالياً.';

/**
 * Per-tenant cost ceiling on in-call knowledge-base searches. Every search runs
 * an OpenAI embedding request plus a vector search, so each one costs real
 * money, and the AGENT decides how often to call it. The company token proves
 * WHICH tenant is calling but says nothing about how often — a model stuck in a
 * tool loop, a provider retry storm, or a leaked token would otherwise bill one
 * company without limit. Uses the same daily-cap mechanism as the chat and
 * outbound-call paths so there is one familiar place to tune it.
 *
 * @returns {Promise<boolean>} false when the company is over its cap today.
 */
async function kbSearchAllowed(companyId, log) {
  if (!companyId) return false;
  let company = null;
  try {
    const { loadCompany } = require('../companies');
    company = await loadCompany(companyId);
  } catch (e) {
    // Fall back to the platform default rather than failing open OR closed on
    // an infrastructure hiccup: the cap still applies, just not the per-company
    // override.
    log?.warn?.('kb tool: company load failed — using the platform cap', { err: e.message, companyId });
  }
  const cap = dailyCap(company, 'dailyKbToolCap', 'DAILY_KB_TOOL_CAP', 1000);
  const ok = await checkAndBumpUsage(companyId, 'kb_tool', cap);
  if (!ok) log?.warn?.('kb tool: daily cap reached — refusing the search', { companyId, cap });
  return ok;
}

async function searchKb(companyId, query, log) {
  if (!companyId) return 'لا تتوفر قاعدة معرفة لهذه المكالمة.';
  if (!query) return 'لم يصل نص للبحث.';
  try {
    const { retrieve } = require('../lib/rag');
    const chunks = await retrieve(companyId, query, { topK: 3 });
    if (!chunks.length) return 'لا توجد معلومات مطابقة في قاعدة المعرفة.';
    // Plain text back to the model; keep it inside a safe token budget.
    return chunks.map((c) => c.text.slice(0, 1200)).join('\n---\n').slice(0, 3800);
  } catch (e) {
    log?.error?.('kb tool: search failed', { err: e.message, companyId });
    return KB_UNAVAILABLE;
  }
}

/**
 * The shared gate every in-call tool passes through, in this order:
 *
 *   1. company from the HMAC token   — never from the request body
 *   2. agent ownership cross-check   — refuses an ambiguous mapping
 *   3. CAPABILITY check              — re-asked on EVERY invocation
 *   4. tenant narrowing              — Postgres RLS becomes the backstop
 *
 * Step 3 is what makes a stale agent harmless. Removing a tool from the agent
 * at publish time is housekeeping, not enforcement: a conversation already in
 * flight, a cached agent version, or a tool an operator re-added by hand can
 * all still call us. The answer has to be "no" here, in the backend, every
 * single time — so disabling a capability takes effect immediately, without
 * republishing.
 *
 * @returns {Promise<{ok:true,companyId:string}|{ok:false,status:number,body:object}>}
 */
async function authorizeToolCall(req, featureKey) {
  const companyId = elevenlabs.verifyCompanyToken(req.get('x-company-token'));
  if (!companyId) {
    req.log.warn('tool call: missing or invalid company token', { ip: req.ip, featureKey });
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }

  // Defence in depth: the provider fills agent_id from its own system variable,
  // so it must map back to the SAME company the token names. A mismatch means
  // either a misconfigured tool or a replayed token, and is refused either way.
  const claimedAgentId = String(req.body?.agent_id || '').trim();
  if (claimedAgentId && !/^\{\{/.test(claimedAgentId)) {
    // uniqueCompanyId returns null when the agent maps to more than one
    // company, so an ambiguous mapping fails this check rather than passing on
    // whichever row came back first.
    const resolved = await elevenlabs.uniqueCompanyId(
      sql.companyByAgentId, claimedAgentId, 'elevenlabs_agent_id', req.log,
    );
    if (resolved !== companyId) {
      req.log.warn('tool call: agent/company mismatch — refusing', {
        companyId, claimedAgentId, resolved, featureKey,
      });
      return { ok: false, status: 403, body: { error: 'forbidden' } };
    }
  }

  if (!(await featureEnabled(companyId, featureKey))) {
    req.log.warn('tool call: capability is not enabled for this company — refusing', {
      companyId, featureKey,
    });
    return { ok: false, status: 403, body: { error: 'forbidden', code: 'FEATURE_DISABLED' } };
  }

  // Narrow the DB tenant context from the system bypass to this one company.
  // The tool tables are FORCE-RLS, so from here Postgres itself refuses rows
  // belonging to anyone else — even if a query ever forgot its company filter.
  if (req.dbContext) { req.dbContext.bypass = false; req.dbContext.companyId = companyId; }

  return { ok: true, companyId };
}

router.post('/elevenlabs/tools/kb', async (req, res) => {
  const auth = await authorizeToolCall(req, 'knowledge_base');
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const { companyId } = auth;

  // Checked AFTER authentication, so an unauthenticated caller cannot burn a
  // tenant's quota by hammering the endpoint.
  if (!(await kbSearchAllowed(companyId, req.log))) {
    // 200 with a plain sentence, not 429: there is a customer on the line and
    // the agent is waiting. An error status makes the model announce a tool
    // failure mid-call; this lets it carry on with the prompt and KB it has.
    return res.json({ result: KB_UNAVAILABLE });
  }

  const query = String(req.body?.query || '').trim().slice(0, 500);
  const result = await searchKb(companyId, query, req.log);
  req.log.info('kb tool handled', { companyId, chars: result.length });
  res.json({ result });
});

module.exports = {
  router, getRecentWebhookAttempts, searchKb,
  // exported for tests
  webhookEventId, kbSearchAllowed, KB_UNAVAILABLE, authorizeToolCall,
};
