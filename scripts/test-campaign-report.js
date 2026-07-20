// Proof suite for campaign reporting.
//
// The design claim under test: every report field is DERIVED from data the
// platform already stores, with no AI pass and no invented values. These tests
// use the exact structured_data shapes observed on real production calls.
//
//   node --test scripts/test-campaign-report.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LEAD, qualifyContact, summarizeReport, composeIntent, deriveNextAction,
} = require('../lib/lead-scoring');
const { applyFilters, toCsv } = require('../services/campaign-report');

// Verbatim from production call 019f687e (90s, assistant-ended-call).
const REAL_HOT = {
  property_type: 'شقة',
  interest_level: 'مهتم جدا',
  preferred_area: 'وسط الرياض',
  callback_requested: false,
  appointment_requested: false,
};
// Verbatim from production call 019f6881 (67s).
const REAL_CALLBACK = {
  property_type: 'فيلا',
  interest_level: 'مهتم',
  callback_requested: true,
  appointment_requested: false,
};
// Verbatim from production call 019f6882 (37s) — customer couldn't hear.
const REAL_NOT_INTERESTED = {
  notes: 'العميل لم يتمكن من سماع المكالمة بشكل جيد (لا يوجد صوت).',
  interest_level: 'غير مهتم',
};

const contact = (o = {}) => ({ id: 1, phone: '+966500000001', status: 'completed', attempts: 1, ...o });
const call = (sd, o = {}) => ({
  duration_sec: 90, ended_reason: 'assistant-ended-call',
  summary: 'ملخص', structured_data: JSON.stringify(sd), ...o,
});

// ─── Lead qualification from REAL production shapes ───────────────
test('production "مهتم جدا" → Hot Lead', () => {
  const q = qualifyContact(contact(), call(REAL_HOT));
  assert.equal(q.lead, LEAD.HOT);
  assert.equal(q.leadLabel.en, 'Hot Lead');
  assert.equal(q.interestLevel, 'مهتم جدا');
});

test('production "مهتم" → Warm Lead, callback flag surfaced', () => {
  const q = qualifyContact(contact(), call(REAL_CALLBACK));
  assert.equal(q.lead, LEAD.WARM);
  assert.equal(q.callbackRequested, true, 'callback tracked as a flag, not a lost category');
});

test('production "غير مهتم" → Not Interested, notes carried through', () => {
  const q = qualifyContact(contact(), call(REAL_NOT_INTERESTED));
  assert.equal(q.lead, LEAD.NOT_INTERESTED);
  assert.match(q.notes, /لم يتمكن من سماع/);
});

test('"متردد" → Cold Lead', () => {
  assert.equal(qualifyContact(contact(), call({ interest_level: 'متردد' })).lead, LEAD.COLD);
});

// ─── Outcomes that precede any conversation ───────────────────────
test('no_answer status → No Answer, regardless of missing analysis', () => {
  const q = qualifyContact(contact({ status: 'no_answer' }), call({}, { duration_sec: 0, ended_reason: 'customer-did-not-answer' }));
  assert.equal(q.lead, LEAD.NO_ANSWER);
});

test('unallocated number → Invalid Number, not No Answer', () => {
  const q = qualifyContact(contact({ status: 'failed' }), call({}, { duration_sec: 0, ended_reason: 'twilio-number-unallocated' }));
  assert.equal(q.lead, LEAD.INVALID, 'an unusable number is operationally different from a missed call');
});

test('never dialled → Pending, not counted as a failure', () => {
  assert.equal(qualifyContact(contact({ status: 'pending' }), null).lead, LEAD.PENDING);
  assert.equal(qualifyContact(contact({ status: 'calling' }), null).lead, LEAD.PENDING);
});

test('a real conversation with no extracted interest → Unqualified, not Cold', () => {
  // Important distinction: "we talked but learned nothing" is not the same as
  // "the customer was lukewarm". Reporting it as Cold would be inventing data.
  const q = qualifyContact(contact(), call({}));
  assert.equal(q.lead, LEAD.UNQUALIFIED);
});

test('a call with no structured_data at all does not crash', () => {
  const q = qualifyContact(contact(), { duration_sec: 30, ended_reason: 'assistant-ended-call', structured_data: null });
  assert.equal(q.lead, LEAD.UNQUALIFIED);
  assert.equal(q.notes, null);
});

test('malformed structured_data JSON degrades instead of throwing', () => {
  const q = qualifyContact(contact(), { duration_sec: 30, structured_data: '{not json' });
  assert.equal(q.lead, LEAD.UNQUALIFIED);
});

// ─── Composed fields (no AI, no invention) ────────────────────────
test('intent is composed from extracted facts only', () => {
  assert.equal(composeIntent(REAL_HOT), 'شقة في وسط الرياض');
  assert.equal(composeIntent({ property_type: 'فيلا', budget: '٢ مليون' }), 'فيلا بميزانية ٢ مليون');
});

test('intent is null when nothing was extracted — never a fabricated sentence', () => {
  assert.equal(composeIntent({}), null);
  assert.equal(qualifyContact(contact(), call({})).intent, null);
});

test('explicit customer_intent from a newer call wins over composition', () => {
  const q = qualifyContact(contact(), call({ ...REAL_HOT, customer_intent: 'يريد شقة بغرفتين للاستثمار' }));
  assert.equal(q.intent, 'يريد شقة بغرفتين للاستثمار');
});

test('explicit next_action wins over the derived one', () => {
  const q = qualifyContact(contact(), call({ ...REAL_HOT, next_action: 'أرسل عرض سعر اليوم' }));
  assert.equal(q.nextAction, 'أرسل عرض سعر اليوم');
});

test('appointment request outranks every other next-action rule', () => {
  assert.match(deriveNextAction(LEAD.COLD, true, { appointment_requested: true }), /موعد المعاينة/);
});

test('next action is derived per lead tier', () => {
  assert.match(deriveNextAction(LEAD.HOT, false, {}), /٢٤ ساعة/);
  assert.match(deriveNextAction(LEAD.NOT_INTERESTED, false, {}), /لا يحتاج/);
  assert.match(deriveNextAction(LEAD.INVALID, false, {}), /صحة الرقم/);
});

// ─── Campaign rollup ──────────────────────────────────────────────
const rowsFixture = [
  { lead: LEAD.HOT,            status: 'completed', durationSec: 90, callbackRequested: false },
  { lead: LEAD.WARM,           status: 'completed', durationSec: 67, callbackRequested: true },
  { lead: LEAD.COLD,           status: 'completed', durationSec: 30, callbackRequested: false },
  { lead: LEAD.NOT_INTERESTED, status: 'completed', durationSec: 37, callbackRequested: false },
  { lead: LEAD.NO_ANSWER,      status: 'no_answer', durationSec: 0,  callbackRequested: false },
  { lead: LEAD.INVALID,        status: 'failed',    durationSec: 0,  callbackRequested: false },
  { lead: LEAD.PENDING,        status: 'pending',   durationSec: 0,  callbackRequested: false },
];

test('rollup counts each lead category', () => {
  const s = summarizeReport(rowsFixture);
  assert.equal(s.totalContacts, 7);
  assert.equal(s.leads[LEAD.HOT], 1);
  assert.equal(s.leads[LEAD.NO_ANSWER], 1);
  assert.equal(s.callbacks, 1);
});

test('answered counts only calls that actually connected', () => {
  const s = summarizeReport(rowsFixture);
  assert.equal(s.answered, 4, 'four calls had a duration > 0');
  assert.equal(s.notAnswered, 2, 'no_answer + failed; pending is not a failure');
});

test('pending contacts are excluded from the dialled denominator', () => {
  const s = summarizeReport(rowsFixture);
  assert.equal(s.dialled, 6, '7 contacts minus 1 still pending');
  assert.equal(s.successRate, Math.round((4 / 6) * 100));
});

test('conversion = hot+warm as a share of answered calls', () => {
  const s = summarizeReport(rowsFixture);
  assert.equal(s.conversionRate, 50, '2 qualified of 4 answered');
});

test('average duration ignores unanswered calls', () => {
  const s = summarizeReport(rowsFixture);
  assert.equal(s.avgDurationSec, Math.round((90 + 67 + 30 + 37) / 4));
});

test('an empty campaign reports zeroes, not NaN', () => {
  const s = summarizeReport([]);
  assert.equal(s.successRate, 0);
  assert.equal(s.conversionRate, 0);
  assert.equal(s.avgDurationSec, 0);
});

// ─── Filters ──────────────────────────────────────────────────────
const filterRows = [
  { phone: '+966500000001', name: 'أبو خالد', lead: LEAD.HOT,  status: 'completed', durationSec: 90, callbackRequested: false, summary: 'يريد شقة', lastAttemptAt: '2026-07-18 10:00:00' },
  { phone: '+966500000002', name: 'أم فهد',   lead: LEAD.WARM, status: 'completed', durationSec: 20, callbackRequested: true,  summary: 'فيلا',     lastAttemptAt: '2026-07-19 10:00:00' },
  { phone: '+966500000003', name: null,       lead: LEAD.NO_ANSWER, status: 'no_answer', durationSec: 0, callbackRequested: false, summary: null, lastAttemptAt: '2026-07-20 10:00:00' },
];

test('filter by lead category', () => {
  assert.equal(applyFilters(filterRows, { lead: LEAD.HOT }).length, 1);
  assert.equal(applyFilters(filterRows, { lead: 'all' }).length, 3);
});

test('the callback pseudo-category filters on the flag', () => {
  const out = applyFilters(filterRows, { lead: 'callback' });
  assert.equal(out.length, 1);
  assert.equal(out[0].phone, '+966500000002');
});

test('filter by call status', () => {
  assert.equal(applyFilters(filterRows, { status: 'no_answer' }).length, 1);
});

test('filter by duration range', () => {
  assert.equal(applyFilters(filterRows, { minDuration: 30 }).length, 1);
  assert.equal(applyFilters(filterRows, { minDuration: 1, maxDuration: 50 }).length, 1);
});

test('filter by date range', () => {
  assert.equal(applyFilters(filterRows, { from: '2026-07-19' }).length, 2);
  assert.equal(applyFilters(filterRows, { from: '2026-07-19', to: '2026-07-19 23:59:59' }).length, 1);
});

test('search matches phone, name and summary', () => {
  assert.equal(applyFilters(filterRows, { search: '0000002' }).length, 1);
  assert.equal(applyFilters(filterRows, { search: 'أبو' }).length, 1);
  assert.equal(applyFilters(filterRows, { search: 'شقة' }).length, 1);
});

test('search tolerates rows with null fields', () => {
  assert.doesNotThrow(() => applyFilters(filterRows, { search: 'xyz' }));
  assert.equal(applyFilters(filterRows, { search: 'xyz' }).length, 0);
});

test('filters combine (AND, not OR)', () => {
  assert.equal(applyFilters(filterRows, { lead: LEAD.WARM, status: 'completed' }).length, 1);
  assert.equal(applyFilters(filterRows, { lead: LEAD.HOT, status: 'no_answer' }).length, 0);
});

// ─── CSV export ───────────────────────────────────────────────────
test('CSV opens correctly in Excel and carries the derived columns', () => {
  const csv = toCsv([{
    phone: '+966500000001', name: 'أبو خالد', status: 'completed', durationSec: 90,
    leadLabel: { ar: 'عميل ساخن', en: 'Hot Lead' }, interestLevel: 'مهتم جدا',
    callbackRequested: true, intent: 'شقة في وسط الرياض', summary: 'ملخص',
    notes: null, nextAction: 'تواصل خلال ٢٤ ساعة', attempts: 1,
  }]);
  assert.ok(csv.startsWith('﻿'), 'UTF-8 BOM so Excel renders Arabic');
  assert.match(csv, /عميل ساخن/);
  assert.match(csv, /مهتم جدا/);
  assert.match(csv, /نعم/, 'callback rendered as a word, not true/false');
  assert.match(csv, /\+966500000001/);
});

test('CSV escapes commas, quotes and newlines in free text', () => {
  const csv = toCsv([{
    phone: '+966500000001', status: 'completed', durationSec: 10,
    leadLabel: { ar: 'عميل بارد' }, callbackRequested: false,
    summary: 'قال: "أبغى شقة, بس مو الحين"\nثم أغلق',
  }]);
  assert.match(csv, /""أبغى شقة, بس مو الحين""/, 'quotes doubled, field wrapped');
  assert.equal(csv.split('\r\n').length, 2, 'embedded newline did not create a row');
});
