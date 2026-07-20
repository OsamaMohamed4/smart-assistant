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
const NO_ANSWER_REASON_RE = /no-?answer|busy|voicemail|machine|timeout|did-not-?answer|customer-did-not/i;

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
    // A failure with no conversation is operationally a non-contact.
    lead = LEAD.INVALID;
  } else {
    // 2. A conversation happened — use what the analysis extracted.
    lead = INTEREST_TO_LEAD[String(sd.interest_level || '').trim()] || LEAD.UNQUALIFIED;
  }

  return {
    lead,
    leadLabel: LEAD_LABELS[lead],
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
  let answered = 0, notAnswered = 0, completed = 0, callbacks = 0;
  let durationTotal = 0, durationCount = 0;

  for (const r of rows) {
    counts[r.lead] = (counts[r.lead] || 0) + 1;
    if (r.callbackRequested) callbacks++;

    const connected = Number(r.durationSec || 0) > 0;
    if (connected) {
      answered++;
      durationTotal += Number(r.durationSec);
      durationCount++;
    } else if (r.status !== 'pending' && r.status !== 'calling') {
      notAnswered++;
    }
    if (r.status === 'completed') completed++;
  }

  const dialled = rows.filter((r) => r.status !== 'pending' && r.status !== 'calling').length;
  const qualified = counts[LEAD.HOT] + counts[LEAD.WARM];

  return {
    totalContacts : rows.length,
    dialled,
    completed,
    answered,
    notAnswered,
    // Success = the dialler reached a real conversation.
    successRate   : dialled ? Math.round((answered / dialled) * 100) : 0,
    // Conversion = of the people who actually talked, how many are worth
    // calling back. This is the number a sales manager is judged on.
    conversionRate: answered ? Math.round((qualified / answered) * 100) : 0,
    avgDurationSec: durationCount ? Math.round(durationTotal / durationCount) : 0,
    callbacks,
    leads: counts,
  };
}

module.exports = {
  LEAD, LEAD_LABELS, INTEREST_TO_LEAD,
  qualifyContact, summarizeReport, composeIntent, deriveNextAction, parseStructured,
};
