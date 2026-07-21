// Proof suite for the minute-precision call window and its UI state (the fix
// for "campaign shows running but nothing happens").
//
//   node --test scripts/test-campaign-window.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_DRIVER = 'sqlite';
const { inCallWindow, windowState, saudiMinutesOfDay } = require('../services/campaigns');

// A fixed instant so tests don't depend on wall-clock. 2026-07-21 19:00 UTC =
// 22:00 Saudi (UTC+3) — exactly the situation in the report: after a 21:00 window.
const at = (utcH, utcM = 0) => new Date(Date.UTC(2026, 6, 21, utcH, utcM));
const SAUDI_22 = at(19, 0);       // 22:00 Saudi
const SAUDI_12 = at(9, 0);        // 12:00 Saudi
const SAUDI_0830 = at(5, 30);     // 08:30 Saudi

const camp = (sh, sm, eh, em) => ({ start_hour: sh, start_minute: sm, end_hour: eh, end_minute: em });

test('saudiMinutesOfDay is UTC+3', () => {
  assert.equal(saudiMinutesOfDay(at(19, 0)), 22 * 60);       // 22:00
  assert.equal(saudiMinutesOfDay(at(5, 30)), 8 * 60 + 30);   // 08:30
});

// ─── The exact bug from the screenshot ────────────────────────────
test('THE REPORT: 08:00–21:00 window is CLOSED at 22:00 Saudi', () => {
  assert.equal(inCallWindow(camp(8, 0, 21, 0), SAUDI_22), false);
});

test('THE REPORT: 08:00–15:00 window is CLOSED at 22:00 Saudi', () => {
  assert.equal(inCallWindow(camp(8, 0, 15, 0), SAUDI_22), false);
});

test('same 08:00–21:00 window is OPEN at 12:00 Saudi', () => {
  assert.equal(inCallWindow(camp(8, 0, 21, 0), SAUDI_12), true);
});

// ─── Minute precision (the new capability) ────────────────────────
test('08:30 start excludes 08:00–08:29', () => {
  assert.equal(inCallWindow(camp(8, 30, 21, 0), at(5, 0)), false);   // 08:00 Saudi
  assert.equal(inCallWindow(camp(8, 30, 21, 0), at(5, 30)), true);   // 08:30 Saudi
});

test('end minute is exclusive: 15:30 end closes exactly at 15:30', () => {
  assert.equal(inCallWindow(camp(8, 0, 15, 30), at(12, 29)), true);  // 15:29 Saudi
  assert.equal(inCallWindow(camp(8, 0, 15, 30), at(12, 30)), false); // 15:30 Saudi
});

test('overnight window 20:00 → 02:00 wraps midnight', () => {
  assert.equal(inCallWindow(camp(20, 0, 2, 0), at(20, 0)), true);    // 23:00 Saudi
  assert.equal(inCallWindow(camp(20, 0, 2, 0), at(22, 30)), true);   // 01:30 Saudi
  assert.equal(inCallWindow(camp(20, 0, 2, 0), at(9, 0)), false);    // 12:00 Saudi
});

test('degenerate equal start/end = always open', () => {
  assert.equal(inCallWindow(camp(0, 0, 0, 0), SAUDI_22), true);
});

test('a campaign with no minute columns behaves as :00 (backward compatible)', () => {
  // Old rows have start_hour/end_hour but undefined minutes.
  const legacy = { start_hour: 8, end_hour: 21 };
  assert.equal(inCallWindow(legacy, SAUDI_12), true);
  assert.equal(inCallWindow(legacy, SAUDI_22), false);
});

// ─── windowState: what the UI shows ───────────────────────────────
test('windowState explains a closed window + when it reopens', () => {
  const w = windowState(camp(8, 0, 21, 0), SAUDI_22);
  assert.equal(w.open, false);
  assert.equal(w.startLabel, '08:00');
  assert.equal(w.endLabel, '21:00');
  // 22:00 now, opens 08:00 tomorrow → 10 hours = 600 minutes.
  assert.equal(w.opensInMin, 600);
});

test('windowState reports open with null wait when inside the window', () => {
  const w = windowState(camp(8, 0, 21, 0), SAUDI_12);
  assert.equal(w.open, true);
  assert.equal(w.opensInMin, null);
});

test('windowState labels carry minutes', () => {
  const w = windowState(camp(9, 30, 17, 45), SAUDI_22);
  assert.equal(w.startLabel, '09:30');
  assert.equal(w.endLabel, '17:45');
});

test('opensInMin for a window later the same day', () => {
  const w = windowState(camp(14, 0, 18, 0), SAUDI_12);   // now 12:00, opens 14:00
  assert.equal(w.open, false);
  assert.equal(w.opensInMin, 120);
});
