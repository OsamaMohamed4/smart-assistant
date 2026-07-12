// Outgoing webhooks: notify a company's own system when one of its calls
// completes. Opt-in per company via settings.webhookUrl (+ optional
// settings.webhookSecret → HMAC-SHA256 of the raw body in X-Signature so
// the receiver can verify authenticity). Fire-and-forget with one retry:
// a customer's broken endpoint must never affect call processing.
const crypto = require('crypto');
const axios = require('axios');
const { logger } = require('../lib/logger');

const TIMEOUT_MS = 5_000;

function buildPayload(companyId, callRow) {
  return JSON.stringify({
    event     : 'call.completed',
    company_id: companyId,
    sent_at   : new Date().toISOString(),
    call: {
      id           : callRow.id,
      direction    : callRow.direction,
      caller_number: callRow.caller_number,
      duration_sec : callRow.duration_sec,
      started_at   : callRow.started_at,
      ended_at     : callRow.ended_at,
      ended_reason : callRow.ended_reason,
      summary      : callRow.summary,
      transcript   : callRow.transcript,
      recording_url: callRow.recording_url,
    },
  });
}

// Fire-and-forget. Never throws; one retry after 5s on any failure.
function sendCallCompleted(company, callRow) {
  const url = String(company?.settings?.webhookUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return;

  const body = buildPayload(company.id, callRow);
  const headers = { 'Content-Type': 'application/json' };
  const secret = String(company.settings?.webhookSecret || '').trim();
  if (secret) {
    headers['X-Signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  const post = () => axios.post(url, body, { headers, timeout: TIMEOUT_MS });
  post()
    .then(() => logger.info('outbound webhook delivered', { companyId: company.id, callId: callRow.id }))
    .catch((e1) => {
      setTimeout(() => {
        post()
          .then(() => logger.info('outbound webhook delivered (retry)', { companyId: company.id, callId: callRow.id }))
          .catch((e2) => logger.warn('outbound webhook failed after retry', {
            companyId: company.id, callId: callRow.id,
            firstErr: e1.message, retryErr: e2.message,
          }));
      }, 5_000).unref();
    });
}

module.exports = { sendCallCompleted };
