// Call-event pipeline: everything that turns a Vapi event (webhook message
// or REST call object) into a row in `calls`. Shared by the webhook route,
// the background drain, and the admin backfill.
const crypto = require('crypto');
const { db, sql } = require('../db');
const { summarize } = require('../summarize');
const { logger } = require('../lib/logger');

// Resolve which company a Vapi call belongs to. Primary key is the assistant
// ID (matches assistant_id OR assistant_id_inbound). But assistant IDs change
// whenever an assistant is recreated on re-sync, which orphans older calls.
// Phone-number IDs never change, so we fall back to matching the call's
// phoneNumberId against the inbound/outbound number IDs stored per company in
// settings JSON. This keeps call logging correct across assistant churn.
function matchCompanyForCall(assistantId, phoneNumberId) {
  if (assistantId) {
    const byAssistant = db
      .prepare('SELECT id FROM companies WHERE assistant_id = ? OR assistant_id_inbound = ?')
      .get(assistantId, assistantId);
    if (byAssistant) return byAssistant;
  }
  if (phoneNumberId) {
    const byPhone = db
      .prepare(
        `SELECT id FROM companies
         WHERE json_extract(settings,'$.inboundPhoneNumberId')  = ?
            OR json_extract(settings,'$.outboundPhoneNumberId') = ?`,
      )
      .get(phoneNumberId, phoneNumberId);
    if (byPhone) return byPhone;
  }
  return null;
}

// Process a single Vapi event (webhook `message` envelope). Idempotent:
// upsertCall is keyed by call.id, and we no-op if a duplicate event_id was
// already inserted.
async function processVapiEvent(msg) {
  if (!msg) return;
  if (msg.type !== 'end-of-call-report' && msg.type !== 'status-update') return;

  const call = msg.call || {};
  const assistantId = call.assistantId || msg.assistant?.id;
  const phoneNumberId = call.phoneNumberId || msg.phoneNumber?.id || null;
  const companyRow = matchCompanyForCall(assistantId, phoneNumberId);

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
      recording_url : msg.artifact?.recordingUrl || msg.recordingUrl || call.artifact?.recordingUrl || null,
    });

    if (transcript && (!msg.summary || msg.summary.length < 20)) {
      const ours = await summarize(transcript);
      if (ours) sql.setCallSummary.run(ours, call.id);
    }
  }
}

// Upsert a single Vapi call object (from the REST list/get API) into our
// calls table. Mirrors the mapping in processVapiEvent but works on the
// call object directly rather than a webhook envelope. Returns the matched
// company id (or null). Used by the admin backfill so calls that missed
// their webhook still show up in the dashboard.
function upsertVapiCall(v) {
  if (!v || !v.id) return null;
  const assistantId = v.assistantId || v.assistant?.id || null;
  const companyRow = matchCompanyForCall(assistantId, v.phoneNumberId || null);
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
    recording_url : v.artifact?.recordingUrl || v.recordingUrl || null,
  });
  return companyRow?.id || null;
}

// Drain up to N pending webhook events on a tick. Called from the webhook
// route after each event and from the background timer below.
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

// Background drain every 60s. Without this, a failed event only got retried
// when the NEXT webhook arrived — an evening failure could sit unprocessed
// until the next morning's first call. unref() so it never blocks shutdown.
function startDrainTimer() {
  const t = setInterval(() => {
    drainWebhookInbox(10).catch((e) => logger.error('scheduled drain failed', { err: e.message }));
  }, 60_000);
  t.unref();
  return t;
}

module.exports = {
  matchCompanyForCall,
  processVapiEvent,
  upsertVapiCall,
  drainWebhookInbox,
  startDrainTimer,
};
