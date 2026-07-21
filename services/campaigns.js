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
const { encryptField, decryptField } = require('../lib/pii');

const VAPI_TIMEOUT_MS = 20_000;
const STALE_CALLING_MIN = 30;
const PER_TICK_CAP = 5;            // max calls placed per campaign per tick

// 'YYYY-MM-DD HH:MM:SS' UTC — matches the storage format on both drivers.
function utcStamp(msAgo = 0) {
  return new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
}

// Extract a bindable STRING from any thrown error. Providers return error
// bodies in wildly different shapes — Vapi's `message` is frequently an array
// of validation strings — so a naive `.slice()` yields a non-string that then
// fails to bind to SQL. Always returns a short string, never throws.
function errToString(e) {
  let m = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'call failed';
  if (Array.isArray(m)) m = m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ');
  else if (m && typeof m === 'object') m = JSON.stringify(m);
  return String(m).slice(0, 300);
}

// Saudi Arabia is UTC+3 year-round (no DST).
function saudiHour() {
  return (new Date().getUTCHours() + 3) % 24;
}

// Minutes since Saudi midnight — the unit the window is compared in now that
// campaigns support HH:MM, not just whole hours.
function saudiMinutesOfDay(now = new Date()) {
  return ((now.getUTCHours() + 3) % 24) * 60 + now.getUTCMinutes();
}

const windowStart = (c) => (Number(c.start_hour) || 0) * 60 + (Number(c.start_minute) || 0);
const windowEnd   = (c) => (Number(c.end_hour) || 0) * 60 + (Number(c.end_minute) || 0);

function inCallWindow(campaign, now = new Date()) {
  const m = saudiMinutesOfDay(now);
  const s = windowStart(campaign);
  const e = windowEnd(campaign);
  if (s === e) return true;                    // degenerate: always open
  if (s < e) return m >= s && m < e;           // e.g. 10:00 → 21:30
  return m >= s || m < e;                      // overnight window e.g. 20:00 → 02:00
}

// Everything the UI needs to explain a running-but-idle campaign, so "pending"
// is never a mystery. `opensInMin` is how long until the window reopens.
function windowState(campaign, now = new Date()) {
  const open = inCallWindow(campaign, now);
  const s = windowStart(campaign);
  const m = saudiMinutesOfDay(now);
  let opensInMin = null;
  if (!open) opensInMin = ((s - m) % 1440 + 1440) % 1440;   // minutes until start, wrapping midnight
  const hhmm = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return {
    open,
    startLabel: hhmm(s),
    endLabel  : hhmm(windowEnd(campaign)),
    opensInMin,
  };
}

// Place one Vapi call for a contact. Mirrors the Playground outbound-call
// path exactly (same overrides) so campaign calls behave like manual ones.
async function placeCall(company, campaign, contact) {
  let vars = {};
  try { vars = contact.variables ? JSON.parse(contact.variables) : {}; } catch {}
  if (contact.name && !vars.customer_name) vars.customer_name = contact.name;

  // The stored phone may be ciphertext (DATA_ENCRYPTION_KEY set). Vapi needs
  // the real E.164 number, so decrypt at the last possible moment. Guard the
  // result: dialling a ciphertext string would fail the call and, worse, log
  // it — so refuse loudly instead.
  const dialNumber = decryptField(contact.phone);
  if (!/^\+[1-9]\d{7,14}$/.test(String(dialNumber || ''))) {
    throw new Error('contact phone is unreadable (decryption failed or malformed)');
  }

  const overrides = { variableValues: vars, firstMessageMode: 'assistant-speaks-first' };
  const activeScenario = await sql.getActiveScenarioForCompany.get(company.id);
  if (activeScenario?.first_message) overrides.firstMessage = activeScenario.first_message;

  const r = await axios.post(
    'https://api.vapi.ai/call',
    {
      assistantId       : company.assistantId,
      phoneNumberId     : company.settings?.outboundPhoneNumberId || process.env.VAPI_PHONE_NUMBER_ID,
      customer          : { number: dialNumber },
      assistantOverrides: overrides,
    },
    { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: VAPI_TIMEOUT_MS },
  );
  return r.data.id;
}

// One tick for one campaign. Returns a STRUCTURED result — { placed, done,
// reason, detail } — so the worker, the logs, and the manual run-now endpoint
// all report exactly why a campaign did or didn't dial. `reason` is one of:
//   dialed | no_pending | completed | outside_window | no_slots |
//   not_published | no_number | daily_cap
// Exposed for tests.
async function tickCampaign(campaign) {
  const done = (reason, detail) => ({ placed: 0, done: reason === 'completed', reason, detail: detail || null });

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
    return done('completed');
  }

  // 4. Respect the call window. Report the exact time comparison so a
  //    timezone problem would be visible in the reason itself.
  if (!inCallWindow(campaign)) {
    const w = windowState(campaign);
    return done('outside_window', {
      saudiTime: hhmmNow(), window: `${w.startLabel}-${w.endLabel}`, opensInMin: w.opensInMin,
    });
  }

  // 5. Concurrency budget.
  const calling = (await sql.countCallingContacts.get(campaign.id))?.n || 0;
  const slots = Math.min(campaign.max_concurrent - calling, PER_TICK_CAP);
  if (slots <= 0) return done('no_slots', { calling, maxConcurrent: campaign.max_concurrent });

  const company = await loadCompany(campaign.company_id);
  if (!company?.assistantId) {
    logger.warn('campaign company not published — pausing', { campaignId: campaign.id, companyId: campaign.company_id });
    await sql.setCampaignStatus.run({ id: campaign.id, status: 'paused' });
    return done('not_published');
  }
  if (!(company.settings?.outboundPhoneNumberId || process.env.VAPI_PHONE_NUMBER_ID)) {
    logger.warn('campaign has no outbound number — pausing', { campaignId: campaign.id, companyId: campaign.company_id });
    await sql.setCampaignStatus.run({ id: campaign.id, status: 'paused' });
    return done('no_number');
  }

  const contacts = await sql.pickPendingContacts.all(campaign.id, slots);
  let placed = 0;
  let dailyCapHit = false;
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
      dailyCapHit = true;
      break;
    }
    try {
      const callId = await placeCall(company, campaign, contact);
      await sql.setContactCallId.run({ id: contact.id, call_id: callId });
      await sql.insertOutboundCallStub.run({
        id: callId, company_id: company.id, assistant_id: company.assistantId,
        // contact.phone is ALREADY in storage form (ciphertext when the key is
        // set, plaintext otherwise) — passing it through keeps calls.caller_number
        // consistent without re-encrypting an already-encrypted value.
        caller_number: contact.phone,
      });
      placed++;
    } catch (e) {
      // Vapi returns validation errors with `message` as an ARRAY, so the old
      // `.slice()` produced an array that then failed to bind to SQL — which
      // threw out of the whole tick, was swallowed by the per-campaign catch,
      // and left the contact stuck. Always coerce to a plain string.
      const err = errToString(e);
      await sql.markContactError.run({ id: contact.id, err });
      logger.warn('campaign call failed to place', { campaignId: campaign.id, contactId: contact.id, err });
    }
  }
  if (placed) logger.info('campaign tick placed calls', { campaignId: campaign.id, placed });
  const reason = placed ? 'dialed' : (dailyCapHit ? 'daily_cap' : 'no_pending');
  return { placed, done: false, reason, detail: { slots, contactsPicked: contacts.length } };
}

// Current Saudi wall-clock as HH:MM, for logging/diagnostics — proves which
// timezone the window check actually used.
function hhmmNow(now = new Date()) {
  const m = saudiMinutesOfDay(now);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Read-only diagnosis for the UI/API: WHY is this campaign (not) dialing right
// now, without mutating anything. Mirrors tickCampaign's decision order.
async function diagnoseCampaign(campaign) {
  const w = windowState(campaign);
  const stats = {};
  for (const s of await sql.campaignContactStats.all(campaign.id)) stats[s.status] = s.n;
  const pending = stats.pending || 0;
  const calling = stats.calling || 0;

  let reason = 'idle';
  if (campaign.status !== 'running') reason = campaign.status;      // draft/paused/completed/cancelled
  else if (!w.open) reason = 'outside_window';
  else if (pending === 0 && calling === 0) reason = 'no_pending';
  else if (calling >= campaign.max_concurrent) reason = 'no_slots';
  else {
    const company = await loadCompany(campaign.company_id);
    if (!company?.assistantId) reason = 'not_published';
    else if (!(company.settings?.outboundPhoneNumberId || process.env.VAPI_PHONE_NUMBER_ID)) reason = 'no_number';
    else reason = 'dialing';                                        // healthy: should place calls next tick
  }
  return { reason, window: w, saudiTime: hhmmNow(), pending, calling };
}

let ticking = false;

// Worker heartbeat — proves the scheduler is actually executing and records
// what each tick did. Exposed via /health (campaign_worker) so "is the worker
// running?" has a definitive answer instead of a guess.
const health = {
  mode: null,             // 'bullmq' | 'timer' | null (not started)
  startedAt: null,
  lastTickAt: null,
  lastTickMs: null,
  ticks: 0,
  lastRunningCount: 0,
  lastPlaced: 0,
  lastError: null,
};
function getWorkerHealth() {
  const stale = health.lastTickAt
    ? (Date.now() - new Date(health.lastTickAt).getTime()) > (Number(process.env.CAMPAIGNS_TICK_MS) || 30_000) * 3
    : true;
  return { ...health, healthy: !!health.lastTickAt && !stale };
}

// Remember the last logged skip reason per campaign so routine skips
// (outside_window every 30s) log ONCE on change, not on every tick.
const lastReason = new Map();

async function tick() {
  if (ticking) return;                 // ticks never overlap (belt) — the
  ticking = true;                      // atomic claim is the suspenders
  const t0 = Date.now();
  let placedTotal = 0;
  try {
    const running = await sql.listRunningCampaigns.all();
    health.lastRunningCount = running.length;
    for (const campaign of running) {
      try {
        const res = await tickCampaign(campaign);
        placedTotal += res.placed || 0;
        // Log the reason only when it CHANGES for this campaign, so the log
        // shows exactly why a campaign is idle without spamming every 30s.
        const key = String(campaign.id);
        if (lastReason.get(key) !== res.reason) {
          lastReason.set(key, res.reason);
          const lvl = res.reason === 'dialed' || res.reason === 'completed' ? 'info' : 'info';
          logger[lvl]('campaign tick reason', {
            campaignId: campaign.id, reason: res.reason, placed: res.placed, ...res.detail,
          });
        }
      } catch (e) {
        logger.error('campaign tick failed', { campaignId: campaign.id, err: e.message });
        lastReason.set(String(campaign.id), 'error');
      }
    }
    health.lastError = null;
  } catch (e) {
    // A failure fetching the campaign list means NOTHING dials — surface it
    // loudly rather than letting every campaign sit silently pending.
    health.lastError = e.message;
    logger.error('campaign tick loop failed', { err: e.message });
  } finally {
    health.ticks += 1;
    health.lastTickAt = new Date().toISOString();
    health.lastTickMs = Date.now() - t0;
    health.lastPlaced = placedTotal;
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

// Start the in-process timer scheduler. Always works; the only downside vs
// BullMQ is it must run on exactly one instance.
function startTimer(interval, reason) {
  const t = setInterval(() => tick().catch((e) => logger.error('campaign worker tick error', { err: e.message })), interval);
  t.unref();
  health.mode = 'timer';
  health.startedAt = new Date().toISOString();
  logger.info(`campaign worker started (in-process timer${reason ? ` — ${reason}` : ''})`, { intervalMs: interval });
  // Kick immediately so the first tick (and its heartbeat) don't wait a full
  // interval — makes "is it running?" answerable within seconds of boot.
  tick().catch(() => {});
  return t;
}

function startCampaignWorker() {
  const interval = Number(process.env.CAMPAIGNS_TICK_MS) || 30_000;

  if (!queue.enabled) {
    return startTimer(interval, 'set REDIS_URL for durability');
  }

  // Durable path: BullMQ repeatable job. BUT the pooled Redis connection never
  // fails a command (it retries forever), so a broken/misconfigured Redis would
  // make scheduleRepeatable HANG and the worker would silently never tick.
  // Verify connectivity first; if Redis isn't reachable, fall back to the timer
  // so campaigns ALWAYS dial rather than sitting pending with no explanation.
  queue.ping(3000).then((ok) => {
    if (!ok) {
      logger.error('campaign worker: REDIS_URL set but Redis unreachable — falling back to in-process timer');
      startTimer(interval, 'redis unreachable, degraded to timer');
      return;
    }
    const q = queue.makeQueue('campaigns');
    queue.makeWorker('campaigns', async () => { await tick(); }, { concurrency: 1 });
    queue.scheduleRepeatable(q, 'tick', interval)
      .then(() => {
        health.mode = 'bullmq';
        health.startedAt = new Date().toISOString();
        logger.info('campaign worker started (BullMQ durable queue)', { intervalMs: interval });
      })
      .catch((e) => {
        logger.error('campaign schedule failed — falling back to in-process timer', { err: e.message });
        startTimer(interval, 'bullmq schedule failed, degraded to timer');
      });
  }).catch((e) => {
    logger.error('campaign worker: redis ping errored — falling back to in-process timer', { err: e.message });
    startTimer(interval, 'redis ping errored, degraded to timer');
  });
  return null;
}

module.exports = {
  startCampaignWorker, tick, tickCampaign, handleCallEnded,
  inCallWindow, windowState, saudiHour, saudiMinutesOfDay, hhmmNow,
  diagnoseCampaign, getWorkerHealth,
};
