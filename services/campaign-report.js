// Campaign report assembly.
//
// Reads campaign_contacts LEFT JOINed to calls (one query), decrypts the
// phone, and runs each row through lib/lead-scoring. Nothing here calls an
// LLM: Vapi's analysisPlan already extracted interest level, callback intent
// and notes at end-of-call, and re-deriving them would cost money to produce
// worse answers than the model that had the audio.
const { sql } = require('../db');
const { decryptField } = require('../lib/pii');
const { qualifyContact, summarizeReport, LEAD, LEAD_LABELS } = require('../lib/lead-scoring');

// Build the full row set for a campaign. Returns rows + the rollup computed
// from those exact rows, so the cards can never disagree with the table.
async function buildReport(campaign) {
  const raw = await sql.campaignReportRows.all(campaign.id);

  const rows = raw.map((r) => {
    const q = qualifyContact(r, r.call_id ? r : null);
    return {
      id           : r.id,
      // Stored encrypted when DATA_ENCRYPTION_KEY is set; the report needs the
      // real number so the sales team can dial it.
      phone        : decryptField(r.phone),
      name         : r.name || null,
      status       : r.status,
      attempts     : r.attempts || 0,
      lastAttemptAt: r.last_attempt_at || null,
      callId       : r.call_id || null,
      durationSec  : Number(r.duration_sec || 0),
      callStartedAt: r.call_started_at || null,
      endedReason  : r.ended_reason || null,
      summary      : r.summary || null,
      recordingUrl : r.recording_url || null,
      lastError    : r.last_error || null,
      // ── derived, never invented ──
      lead             : q.lead,
      leadLabel        : q.leadLabel,
      outcome          : q.outcome,
      outcomeLabel     : q.outcomeLabel,
      callbackRequested: q.callbackRequested,
      interestLevel    : q.interestLevel,
      intent           : q.intent,
      notes            : q.notes,
      nextAction       : q.nextAction,
      propertyType     : q.propertyType,
      budget           : q.budget,
      preferredArea    : q.preferredArea,
    };
  });

  return { rows, summary: summarizeReport(rows) };
}

// Server-side filtering so CSV export and the UI apply identical rules.
// `lead: 'callback'` is a pseudo-category: callbacks are tracked as a flag
// (a hot lead who also wants a callback should still read as hot), but the
// report needs to filter and count them as their own bucket.
function applyFilters(rows, f = {}) {
  const search = String(f.search || '').trim().toLowerCase();
  const minDur = Number.isFinite(Number(f.minDuration)) ? Number(f.minDuration) : null;
  const maxDur = Number.isFinite(Number(f.maxDuration)) ? Number(f.maxDuration) : null;
  const from = f.from ? String(f.from) : null;
  const to = f.to ? String(f.to) : null;

  return rows.filter((r) => {
    if (f.lead && f.lead !== 'all') {
      if (f.lead === 'callback') { if (!r.callbackRequested) return false; }
      // 'interested' is the "مهتم بالشراء" card: hot + warm combined, since both
      // expressed buying intent. Kept as a pseudo-category so the card and the
      // dropdown can filter on it without a real lead value.
      else if (f.lead === 'interested') { if (r.lead !== 'hot' && r.lead !== 'warm') return false; }
      else if (r.lead !== f.lead) return false;
    }
    if (f.status && f.status !== 'all' && r.status !== f.status) return false;
    if (f.outcome && f.outcome !== 'all' && r.outcome !== f.outcome) return false;
    if (minDur !== null && r.durationSec < minDur) return false;
    if (maxDur !== null && r.durationSec > maxDur) return false;
    if (from && (r.lastAttemptAt || r.callStartedAt || '') < from) return false;
    if (to && (r.lastAttemptAt || r.callStartedAt || '') > to) return false;
    if (search) {
      const hay = [r.phone, r.name, r.summary, r.notes, r.intent].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

// ─── CSV export ───────────────────────────────────────────────────
// UTF-8 BOM so Excel opens Arabic correctly — same convention as the existing
// calls.csv export. Excel reads this natively; there is no separate .xlsx
// generator because that would mean shipping a ~500KB dependency to produce a
// file Excel already opens.
const CSV_COLUMNS = [
  ['phone',         'رقم الجوال'],
  ['name',          'اسم العميل'],
  ['outcomeLabelAr', 'نتيجة المكالمة'],
  ['durationSec',   'مدة المكالمة (ثانية)'],
  ['leadLabelAr',   'تصنيف العميل'],
  ['interestLevel', 'مستوى الاهتمام'],
  ['callbackYesNo', 'طلب معاودة الاتصال'],
  ['intent',        'طلب العميل'],
  ['propertyType',  'نوع العقار'],
  ['preferredArea', 'المنطقة المفضلة'],
  ['budget',        'الميزانية'],
  ['summary',       'ملخص المكالمة'],
  ['notes',         'ملاحظات'],
  ['nextAction',    'الإجراء التالي'],
  ['attempts',      'عدد المحاولات'],
  ['lastAttemptAt', 'آخر محاولة'],
  // Raw provider signal — the exact reason the call ended (Vapi's endedReason)
  // and any technical placement error, so an operator can see WHY a call failed
  // instead of trusting only the mapped bucket.
  ['endedReason',   'سبب الإنهاء (من المزوّد)'],
  ['lastError',     'الخطأ الفني'],
  ['recordingUrl',  'رابط التسجيل'],
];

const STATUS_AR = {
  pending: 'بالانتظار', calling: 'جارٍ الاتصال', completed: 'تمت',
  no_answer: 'لم يرد', failed: 'فشلت', cancelled: 'ملغاة',
};

function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([, h]) => esc(h)).join(',')];
  for (const r of rows) {
    const flat = {
      ...r,
      outcomeLabelAr: r.outcomeLabel?.ar || r.outcome,
      leadLabelAr : r.leadLabel?.ar || r.lead,
      callbackYesNo: r.callbackRequested ? 'نعم' : 'لا',
    };
    lines.push(CSV_COLUMNS.map(([k]) => esc(flat[k])).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

module.exports = { buildReport, applyFilters, toCsv, CSV_COLUMNS, STATUS_AR, LEAD, LEAD_LABELS };
