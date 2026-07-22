// Lead qualification for campaign reporting.
//
// IMPORTANT: this module runs NO AI. Every value it produces is derived from
// data the platform already stores:
//
//   campaign_contacts.status   — the dialler's own outcome (pending/calling/
//                                completed/no_answer/failed/cancelled)
//   calls.ended_reason         — why the call terminated
//   calls.duration_sec         — how long the conversation lasted
//   calls.summary              — Vapi's post-call summary
//   calls.structured_data      — Vapi's analysisPlan output, already enabled
//                                in production and confirmed populated:
//                                { interest_level, property_type, budget,
//                                  preferred_area, callback_requested,
//                                  appointment_requested, notes }
//
// A second LLM pass over transcripts would cost money and latency to
// re-derive facts Vapi has already extracted, so we don't. Where the report
// asks for something Vapi does not emit (customer intent, next action) we
// COMPOSE it from the fields above rather than invent it — and the composition
// is deterministic, so the same call always reports the same way.
//
// Future calls can carry richer explicit values: the analysisPlan schema now
// also requests customer_intent and next_action. When those are present they
// take precedence; when they are absent (every historical call) the derivation
// below fills in. That is what keeps this fully backward compatible.

// ─── Lead categories ──────────────────────────────────────────────
const LEAD = {
  HOT           : 'hot',
  WARM          : 'warm',
  COLD          : 'cold',
  NOT_INTERESTED: 'not_interested',
  NO_ANSWER     : 'no_answer',
  INVALID       : 'invalid_number',
  FAILED        : 'connection_failed', // reached the platform but never the customer (SIP/infra/placement/timeout)
  UNQUALIFIED   : 'unqualified',   // call connected but no signal extracted
  PENDING       : 'pending',       // not dialled yet
};

const LEAD_LABELS = {
  [LEAD.HOT]           : { ar: 'عميل ساخن',      en: 'Hot Lead' },
  [LEAD.WARM]          : { ar: 'عميل دافئ',      en: 'Warm Lead' },
  [LEAD.COLD]          : { ar: 'عميل بارد',      en: 'Cold Lead' },
  [LEAD.NOT_INTERESTED]: { ar: 'غير مهتم',       en: 'Not Interested' },
  [LEAD.NO_ANSWER]     : { ar: 'لم يرد',         en: 'No Answer' },
  [LEAD.INVALID]       : { ar: 'رقم غير صالح',   en: 'Invalid Number' },
  [LEAD.FAILED]        : { ar: 'تعذّر الاتصال',  en: 'Connection Failed' },
  [LEAD.UNQUALIFIED]   : { ar: 'غير مصنّف',      en: 'Unqualified' },
  [LEAD.PENDING]       : { ar: 'لم يُتصل بعد',   en: 'Not Called Yet' },
};

// Vapi's analysisPlan constrains interest_level to this Arabic enum.
const INTEREST_TO_LEAD = {
  'مهتم جدا' : LEAD.HOT,
  'مهتم جداً': LEAD.HOT,
  'مهتم'     : LEAD.WARM,
  'متردد'    : LEAD.COLD,
  'غير مهتم' : LEAD.NOT_INTERESTED,
};

// ended_reason values that mean the number itself is unusable, as opposed to
// the customer simply not picking up.
const INVALID_REASON_RE = /invalid|not-?in-?service|unallocated|rejected|blocked|forbidden|doesnt-?exist|does-not-exist/i;
const NO_ANSWER_REASON_RE = /no-?answer|voicemail|machine|timeout|did-not-?answer|customer-did-not/i;

// ─── Call outcome (a SEPARATE axis from lead qualification) ───────
// Lead = how interested the customer is. Outcome = what operationally happened
// on the line. A call can be `completed` (outcome) AND `hot` (lead) at once.
// The campaign report's fixed KPI table counts outcomes; the results table
// shows leads. Every value here is read from campaign_contacts.status and
// calls.ended_reason — both already stored — with no AI.
const OUTCOME = {
  PENDING     : 'pending',       // not dialled yet
  COMPLETED   : 'completed',     // assistant ran the scenario to its close
  ENDED_EARLY : 'ended_early',   // customer hung up before the assistant finished
  TRANSFERRED : 'transferred',   // handed to a human agent
  NO_ANSWER   : 'no_answer',     // rang, nobody picked up
  BUSY        : 'busy',          // line busy
  SWITCHED_OFF: 'switched_off',  // phone off / unreachable
  INVALID     : 'invalid',       // number not in service
  FAILED      : 'failed',        // technical/infra failure (e.g. SIP trunk auth)
};

const OUTCOME_LABELS = {
  [OUTCOME.PENDING]     : { ar: 'لم يُتصل بعد',            en: 'Not Called Yet' },
  [OUTCOME.COMPLETED]   : { ar: 'أكمل العميل الحوار',      en: 'Completed' },
  [OUTCOME.ENDED_EARLY] : { ar: 'أُنهيت مبكراً',           en: 'Ended Early' },
  [OUTCOME.TRANSFERRED] : { ar: 'حُوّلت لموظف',            en: 'Transferred' },
  [OUTCOME.NO_ANSWER]   : { ar: 'لم يتم الرد',            en: 'No Answer' },
  [OUTCOME.BUSY]        : { ar: 'مشغول',                  en: 'Busy' },
  [OUTCOME.SWITCHED_OFF]: { ar: 'مغلق',                   en: 'Switched Off' },
  [OUTCOME.INVALID]     : { ar: 'رقم غير صحيح',           en: 'Invalid Number' },
  [OUTCOME.FAILED]      : { ar: 'تعذّر الاتصال',          en: 'Connection Failed' },
};

// Reason patterns, checked in priority order. Derived from the real
// endedReason values observed on this account plus Vapi's documented enum.
const BUSY_RE         = /busy/i;
const SWITCHED_OFF_RE = /switched-?off|powered-?off|unreachable|not-?reachable|unavailable|out-of-service/i;
const TRANSFER_RE     = /forward|transfer/i;
// Infrastructure failures — NOT a customer disposition. On this account these
// are almost all SIP-trunk auth faults (sip-407), which must never be counted
// as "no answer" or the answer-rate becomes meaningless.
const INFRA_FAIL_RE   = /sip-\d|proxy-authentication|providerfault|pipeline-error|provider-fault|failed-to-connect|twilio-failed|did-not-receive-customer-audio|cartesia|deepgram|voice-failed/i;
const CONNECTED_END_RE = /assistant-ended|customer-ended|end-call|hangup|silence-timed-out/i;

// Classify what happened on the line. `connected` (a conversation actually
// occurred) is inferred from a positive duration OR a transcript, since a
// customer-ended call with 3s still connected.
function classifyOutcome(contact, call) {
  const status = String(contact?.status || 'pending');
  const reason = String(call?.ended_reason || contact?.last_error || '').toLowerCase();
  const duration = Number(call?.duration_sec || 0);
  const connected = duration > 0 || !!(call && call.transcript);

  if (status === 'pending' || status === 'calling' || status === 'cancelled') return OUTCOME.PENDING;
  if (!call && status === 'pending') return OUTCOME.PENDING;

  // Dispositions that are clear from the reason regardless of connection.
  if (TRANSFER_RE.test(reason)) return OUTCOME.TRANSFERRED;
  if (INVALID_REASON_RE.test(reason)) return OUTCOME.INVALID;
  if (BUSY_RE.test(reason)) return OUTCOME.BUSY;
  if (SWITCHED_OFF_RE.test(reason)) return OUTCOME.SWITCHED_OFF;

  if (connected) {
    // A real conversation happened. Who ended it decides completed vs early.
    if (/assistant-ended|assistant-forwarded/.test(reason)) return OUTCOME.COMPLETED;
    if (/customer-ended|silence-timed-out|hangup/.test(reason)) return OUTCOME.ENDED_EARLY;
    return OUTCOME.COMPLETED;                       // connected, assistant closed cleanly
  }

  // No conversation. Separate a genuine miss from a platform failure.
  if (INFRA_FAIL_RE.test(reason)) return OUTCOME.FAILED;
  if (NO_ANSWER_REASON_RE.test(reason) || status === 'no_answer') return OUTCOME.NO_ANSWER;
  if (status === 'failed') return OUTCOME.FAILED;
  return OUTCOME.NO_ANSWER;
}

function parseStructured(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// ─── Core: qualify one contact ────────────────────────────────────
// `contact` is a campaign_contacts row; `call` is the joined calls row (may be
// null when the contact was never dialled or the webhook has not landed yet).
function qualifyContact(contact, call) {
  const sd = parseStructured(call?.structured_data);
  const reason = String(call?.ended_reason || contact?.last_error || '').toLowerCase();
  const status = String(contact?.status || 'pending');
  const duration = Number(call?.duration_sec || 0);

  const callbackRequested = sd.callback_requested === true || sd.appointment_requested === true;

  // 1. Outcomes that happened before any conversation take precedence — an
  //    unreachable number has no interest level to speak of.
  let lead;
  if (status === 'pending' || status === 'calling') {
    lead = LEAD.PENDING;
  } else if (status === 'cancelled') {
    lead = LEAD.PENDING;
  } else if (INVALID_REASON_RE.test(reason)) {
    lead = LEAD.INVALID;
  } else if (status === 'no_answer' || NO_ANSWER_REASON_RE.test(reason)) {
    lead = LEAD.NO_ANSWER;
  } else if (status === 'failed' && !duration) {
    // A failure with no conversation is a non-contact — but WHY decides the
    // label. A genuine bad-number reason was already caught above (INVALID). By
    // here the reason is a SIP/infra/placement/timeout fault, meaning we never
    // reached the customer. Labelling that "invalid number" wrongly blames a
    // good number (the operator's complaint); it's a connection failure. The
    // raw reason travels on the row (endedReason / lastError) so the real cause
    // is always visible, not hidden behind the bucket.
    lead = LEAD.FAILED;
  } else {
    // 2. A conversation happened — use what the analysis extracted.
    lead = INTEREST_TO_LEAD[String(sd.interest_level || '').trim()] || LEAD.UNQUALIFIED;
  }

  const outcome = classifyOutcome(contact, call);

  return {
    lead,
    leadLabel: LEAD_LABELS[lead],
    outcome,
    outcomeLabel: OUTCOME_LABELS[outcome],
    callbackRequested,
    interestLevel: sd.interest_level || null,
    // Composed intent: what the customer said they want. Explicit
    // customer_intent wins when a newer call carries it.
    intent: sd.customer_intent || composeIntent(sd) || null,
    notes: sd.notes || null,
    nextAction: sd.next_action || deriveNextAction(lead, callbackRequested, sd),
    propertyType: sd.property_type || null,
    budget: sd.budget || null,
    preferredArea: sd.preferred_area || null,
  };
}

// Qualify a STANDALONE call (not a campaign contact) — used by the general
// call-records export so every downloaded row shows the lead qualification,
// not just the raw Arabic interest_level. Synthesizes the contact status the
// campaign path would have set, from the call's own outcome, so the same
// derivation runs for both.
function qualifyCall(call) {
  if (!call) return qualifyContact({ status: 'pending' }, null);
  const connected = Number(call.duration_sec || 0) > 0 || !!call.transcript;
  const reason = String(call.ended_reason || '').toLowerCase();
  let status = 'completed';
  if (!connected) {
    status = NO_ANSWER_REASON_RE.test(reason) ? 'no_answer' : 'failed';
  }
  return qualifyContact({ status }, call);
}

// Build a one-line intent from the concrete facts Vapi extracted. Returns null
// when nothing was captured — better an empty cell than a fabricated sentence.
function composeIntent(sd) {
  const parts = [];
  if (sd.property_type)  parts.push(sd.property_type);
  if (sd.preferred_area) parts.push(`في ${sd.preferred_area}`);
  if (sd.budget)         parts.push(`بميزانية ${sd.budget}`);
  return parts.length ? parts.join(' ') : null;
}

// Deterministic next-step recommendation. Deliberately conservative: it tells
// the sales team what the CALL established, never invents urgency.
function deriveNextAction(lead, callbackRequested, sd) {
  if (sd.appointment_requested === true) return 'حدّد موعد المعاينة';
  if (callbackRequested)                 return 'اتصل بالعميل في الوقت المطلوب';
  switch (lead) {
    case LEAD.HOT:            return 'تواصل خلال ٢٤ ساعة — أولوية عالية';
    case LEAD.WARM:           return 'أرسل تفاصيل المشروع ثم تابع';
    case LEAD.COLD:           return 'أضفه لقائمة المتابعة طويلة المدى';
    case LEAD.NOT_INTERESTED: return 'لا يحتاج متابعة';
    case LEAD.NO_ANSWER:      return 'أعد المحاولة في وقت مختلف';
    case LEAD.INVALID:        return 'تحقق من صحة الرقم';
    case LEAD.PENDING:        return '—';
    default:                  return 'راجع التسجيل لتحديد الاهتمام';
  }
}

// ─── Aggregate: campaign-level rollup ─────────────────────────────
// Every number here is counted from the rows themselves, so the report can
// never disagree with the table beneath it.
function summarizeReport(rows) {
  const counts = Object.fromEntries(Object.values(LEAD).map((k) => [k, 0]));
  const outcomes = Object.fromEntries(Object.values(OUTCOME).map((k) => [k, 0]));
  let callbacks = 0, durationTotal = 0, durationCount = 0;

  for (const r of rows) {
    counts[r.lead] = (counts[r.lead] || 0) + 1;
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    if (r.callbackRequested) callbacks++;
    if (Number(r.durationSec || 0) > 0) {
      durationTotal += Number(r.durationSec);
      durationCount++;
    }
  }

  const dialled = rows.length - outcomes[OUTCOME.PENDING];
  // "Answered" = a human was reached and a conversation happened. Completed +
  // ended-early + transferred all connected; busy/no-answer/off/invalid/failed
  // did not. Counted from outcomes so it can never drift from the KPI table.
  const answered = outcomes[OUTCOME.COMPLETED] + outcomes[OUTCOME.ENDED_EARLY] + outcomes[OUTCOME.TRANSFERRED];
  const notAnswered = dialled - answered;
  const qualified = counts[LEAD.HOT] + counts[LEAD.WARM];

  return {
    totalContacts : rows.length,
    dialled,
    answered,
    notAnswered,
    completed     : outcomes[OUTCOME.COMPLETED],
    // Answer/connection rate — "نسبة الاتصال".
    successRate   : dialled ? Math.round((answered / dialled) * 100) : 0,
    // Conversion = of the people who actually talked, how many are worth
    // calling back. This is the number a sales manager is judged on.
    conversionRate: answered ? Math.round((qualified / answered) * 100) : 0,
    avgDurationSec: durationCount ? Math.round(durationTotal / durationCount) : 0,
    callbacks,
    leads: counts,
    // Full operational breakdown for the fixed KPI table.
    outcomes,
  };
}

module.exports = {
  LEAD, LEAD_LABELS, INTEREST_TO_LEAD,
  OUTCOME, OUTCOME_LABELS, classifyOutcome,
  qualifyContact, qualifyCall, summarizeReport, composeIntent, deriveNextAction, parseStructured,
};
