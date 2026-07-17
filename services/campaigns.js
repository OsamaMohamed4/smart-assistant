// Outbound campaign engine. A campaign is a contact list the worker dials
// through the company's synced assistant, inside a daily Saudi-time window,
// with bounded concurrency and retry-on-no-answer. The tick loop is
// deliberately simple and idempotent: every state transition lives in the
// campaign_contacts.status column, so a crash mid-tick loses nothing.
//
// Lifecycle per contact:
//   pending → calling → completed | no_answer | failed
//   no_answer/failed re-queue to pending while attempts < max_attempts
//   (after retry_delay_min). Stuck 'calling' rows (webhook never arrived)
//   are failed after 30 minutes and become retryable.
const axios = require('axios');
const queue = require('../lib/queue');
const { sql } = require('../db');
const { logger } = require('../lib/logger');
const { loadCompany } = require('../companies');
const { dailyCap, checkAndBumpUsage } = require('./usage');

const VAPI_TIMEOUT_MS = 20_000;
const STALE_CALLING_MIN = 30;
const PER_TICK_CAP = 5;            // max calls placed per campaign per tick

// 'YYYY-MM-DD HH:MM:SS' UTC — matches the storage format on both drivers.
function utcStamp(msAgo = 0) {
  return new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
}

// Saudi Arabia is UTC+3 year-round (no DST).
function saudiHour() {
  return (new Date().getUTCHours() + 3) % 24;
}

function inCallWindow(campaign) {
  const h = saudiHour();
  const { start_hour: s, end_hour: e } = campaign;
  if (s === e) return true;                    // degenerate: always open
  if (s < e) return h >= s && h < e;           // e.g. 10 → 21
  return h >= s || h < e;                      // overnight window e.g. 20 → 02
}

// Place one Vapi call for a contact. Mirrors the Playground outbound-call
// path exactly (same overrides) so campaign calls behave like manual ones.
async function placeCall(company, campaign, contact) {
  let vars = {};
  try { vars = contact.variables ? JSON.parse(contact.variables) : {}; } catch {}
  if (contact.name && !vars.customer_name) vars.customer_name = contact.name;

  const overrides = { variableValues: vars, firstMessageMode: 'assistant-speaks-first' };
  const activeScenario = await sql.getActiveScenarioForCompany.get(company.id);
  if (activeScenario?.first_message) overrides.firstMessage = activeScenario.first_message;

  const r = await axios.post(
    'https://api.vapi.ai/call',
    {
      assistantId       : company.assistantId,
      phoneNumberId     : company.settings?.outboundPhoneNumberId || process.env.VAPI_PHONE_NUMBER_ID,
      customer          : { number: contact.phone },
      assistantOverrides: overrides,
    },
    { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: VAPI_TIMEOUT_MS },
  );
  return r.data.id;
}

// One tick for one campaign. Exposed for tests.
async function tickCampaign(campaign) {
  // 1. Recycle stuck 'calling' rows (lost webhooks) into retryable failures.
  await sql.requeueStaleCalling.run(campaign.id, utcStamp(STALE_CALLING_MIN * 60 * 1000));

  // 2. Re-queue retryable failures whose delay has elapsed.
  await sql.requeueRetryContacts.run(
    campaign.id, campaign.max_attempts, utcStamp(campaign.retry_delay_min * 60 * 1000),
  );

  // 3. Done? (nothing pending/calling and nothing retryable)
  const remaining = (await sql.countRemainingContacts.get(campaign.id, campaign.max_attempts))?.n || 0;
  if (remaining === 0) {
    await sql.completeCampaign.run(campaign.id);
    logger.info('campaign completed', { campaignId: campaign.id });
    return { placed: 0, done: true };
  }

  // 4. Respect the call window.
  if (!inCallWindow(campaign)) return { placed: 0, done: false, outsideWindow: true };

  // 5. Concurrency budget.
  const calling = (await sql.countCallingContacts.get(campaign.id))?.n || 0;
  const slots = Math.min(campaign.max_concurrent - calling, PER_TICK_CAP);
  if (slots <= 0) return { placed: 0, done: false };

  const company = await loadCompany(campaign.company_id);
  if (!company?.assistantId) {
    logger.warn('campaign company not published — pausing', { campaignId: campaign.id });
    await sql.setCampaignStatus.run({ id: campaign.id, status: 'paused' });
    return { placed: 0, done: false };
  }
  if (!(company.settings?.outboundPhoneNumberId || process.env.VAPI_PHONE_NUMBER_ID)) {
    logger.warn('campaign has no outbound number — pausing', { campaignId: campaign.id });
    await sql.setCampaignStatus.run({ id: campaign.id, status: 'paused' });
    return { placed: 0, done: false };
  }

  const contacts = await sql.pickPendingContacts.all(campaign.id, slots);
  let placed = 0;
  for (const contact of contacts) {
    // CLAIM FIRST (atomic pending→calling flip), place the call second. The
    // reverse order let an overlapping tick re-pick a contact mid-placement
    // and dial the same customer twice.
    const claim = await sql.claimContact.run({ id: contact.id, at: utcStamp() });
    if (!claim.changes) continue;                 // someone else got it

    // Daily budget is a hard stop — never bypassed by campaigns.
    const capOk = await checkAndBumpUsage(
      company.id, 'outbound_calls', dailyCap(company, 'dailyOutboundCap', 'DAILY_OUTBOUND_CAP', 200),
    );
    if (!capOk) {
      await sql.markContactError.run({ id: contact.id, err: 'daily outbound cap reached' });
      logger.warn('campaign hit daily outbound cap — waiting for tomorrow', { campaignId: campaign.id });
      break;
    }
    try {
      const callId = await placeCall(company, campaign, contact);
      await sql.setContactCallId.run({ id: contact.id, call_id: callId });
      await sql.insertOutboundCallStub.run({
        id: callId, company_id: company.id, assistant_id: company.assistantId, caller_number: contact.phone,
      });
      placed++;
    } catch (e) {
      const err = (e.response?.data?.message || e.message || 'call failed').slice(0, 300);
      await sql.markContactError.run({ id: contact.id, err });
      logger.warn('campaign call failed to place', { campaignId: campaign.id, contactId: contact.id, err });
    }
  }
  if (placed) logger.info('campaign tick placed calls', { campaignId: campaign.id, placed });
  return { placed, done: false };
}

let ticking = false;

async function tick() {
  if (ticking) return;                 // ticks never overlap (belt) — the
  ticking = true;                      // atomic claim is the suspenders
  try {
    const running = await sql.listRunningCampaigns.all();
    for (const campaign of running) {
      try { await tickCampaign(campaign); } catch (e) {
        logger.error('campaign tick failed', { campaignId: campaign.id, err: e.message });
      }
    }
  } finally {
    ticking = false;
  }
}

// Map a finished call back to its campaign contact. Called from the
// end-of-call pipeline (services/call-events.js).
async function handleCallEnded(callId, endedReason, durationSec) {
  if (!callId) return;
  const reason = String(endedReason || '').toLowerCase();
  let status;
  if (/no-answer|busy|voicemail|machine/.test(reason)) status = 'no_answer';
  else if (/customer-ended|assistant-ended|end-call/.test(reason) && (durationSec || 0) >= 5) status = 'completed';
  else if (!reason) status = 'no_answer';
  else status = /error|failed|rejected|did-not/.test(reason) ? 'failed' : 'completed';
  const r = await sql.updateContactByCallId.run({ call_id: callId, status, err: status === 'completed' ? null : reason });
  if (r.changes) logger.info('campaign contact updated from call', { callId, status });
}

function startCampaignWorker() {
  const interval = Number(process.env.CAMPAIGNS_TICK_MS) || 30_000;
  // Durable path: a BullMQ repeatable job replaces setInterval so the schedule
  // survives restarts and is safe across multiple app instances.
  if (queue.enabled) {
    const q = queue.makeQueue('campaigns');
    queue.makeWorker('campaigns', async () => { await tick(); }, { concurrency: 1 });
    queue.scheduleRepeatable(q, 'tick', interval)
      .catch((e) => logger.error('campaign schedule failed', { err: e.message }));
    logger.info('campaign worker started (BullMQ durable queue)', { intervalMs: interval });
    return null;
  }
  // Fallback: in-process timer when no REDIS_URL is configured (dev/CI/local).
  const t = setInterval(() => tick().catch((e) => logger.error('campaign worker tick error', { err: e.message })), interval);
  t.unref();
  logger.info('campaign worker started (in-process timer — set REDIS_URL for durability)', { intervalMs: interval });
  return t;
}

module.exports = { startCampaignWorker, tick, tickCampaign, handleCallEnded, inCallWindow, saudiHour };
