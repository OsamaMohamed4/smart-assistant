// The monthly invoice: the contract's rules, worked through on numbers.
//
//   node --test scripts/test-invoice.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { callUnits, priceExtra, computeInvoice, contractPeriod, sar, DEFAULT_CONTRACT } = require('../lib/invoice');

test('a call under a minute is not counted; every started four minutes is one call', () => {
  const cases = [[0, 0], [30, 0], [59, 0], [60, 1], [61, 1], [240, 1], [241, 2], [480, 2], [481, 3], [3600, 15]];
  for (const [sec, units] of cases) assert.equal(callUnits(sec), units, `${sec}s`);
});

test('the 2,250 included calls are used up first, across the whole contract', () => {
  // 2,000 used in earlier months; this month 400 one-call calls.
  const inv = computeInvoice({ unitsBefore: 2000, monthDurations: Array(400).fill(90) });
  assert.equal(inv.outbound.units, 400);
  assert.equal(inv.outbound.includedUsed, 250);
  assert.equal(inv.outbound.includedLeft, 0);
  assert.equal(inv.outbound.extra, 150);
  assert.deepEqual(inv.lines, [{ from: 1, to: 150, units: 150, unitPrice: 170, amount: 25500 }]);
  assert.equal(sar(inv.total), '255.00');
});

test('inside the included calls the month costs nothing, and what is left is reported', () => {
  const inv = computeInvoice({ unitsBefore: 100, monthDurations: [60, 300, 10, 0] });
  assert.equal(inv.outbound.calls, 4);
  assert.equal(inv.outbound.answered, 3);
  assert.equal(inv.outbound.billableCalls, 2);
  assert.equal(inv.outbound.units, 3);              // 60s → 1, 300s → 2
  assert.equal(inv.outbound.includedLeft, 2250 - 103);
  assert.equal(inv.total, 0);
  assert.deepEqual(inv.lines, []);
});

test('the tiers are graduated, and they start again every month', () => {
  const { lines } = priceExtra(12000);
  assert.deepEqual(lines.map((l) => [l.from, l.to, l.unitPrice]), [[1, 10000, 170], [10001, 12000, 150]]);
  assert.equal(lines.reduce((n, l) => n + l.amount, 0), 10000 * 170 + 2000 * 150);
  // A month that follows a busy one is priced from the first tier again: the
  // tiers read only this month's extra calls.
  const next = computeInvoice({ unitsBefore: 50000, monthDurations: [90, 90] });
  assert.equal(next.lines[0].unitPrice, 170);
});

test('beyond 100,000 extra calls the count is reported for a special quote, never priced', () => {
  const { lines, beyondTiers } = priceExtra(100500);
  assert.equal(lines.reduce((n, l) => n + l.units, 0), 100000);
  assert.equal(lines.reduce((n, l) => n + l.amount, 0), 10000 * 170 + 40000 * 150 + 50000 * 130);
  assert.equal(beyondTiers, 500);
  const inv = computeInvoice({ unitsBefore: 2250, monthDurations: Array(100500).fill(60) });
  assert.equal(inv.needsQuote, true);
  assert.equal(inv.outbound.beyondTiers, 500);
});

test('inbound calls are shown and never billed', () => {
  const inv = computeInvoice({ unitsBefore: 2250, monthDurations: [], inbound: { calls: 900, seconds: 54000 } });
  assert.deepEqual(inv.inbound, { calls: 900, seconds: 54000 });
  assert.equal(inv.total, 0);
});

test('money is exact: three calls at 1.70 are 5.10', () => {
  const inv = computeInvoice({ unitsBefore: 2250, monthDurations: [60, 60, 60] });
  assert.equal(inv.total, 510);
  assert.equal(sar(inv.total), '5.10');
});

test('VAT is added only when the contract says so, at its rate', () => {
  const base = { unitsBefore: 2250, monthDurations: Array(150).fill(60) };
  assert.equal(computeInvoice(base).vat, 0);
  const withVat = computeInvoice({ ...base, contract: { vat: 'add', vatRate: 15 } });
  assert.equal(withVat.subtotal, 25500);
  assert.equal(withVat.vat, 3825);
  assert.equal(sar(withVat.total), '293.25');
});

test('a fixed monthly amount is added to the usage when the contract has one', () => {
  const inv = computeInvoice({ unitsBefore: 0, monthDurations: [], contract: { monthlyFee: 1500 } });
  assert.equal(inv.monthlyFee, 150000);
  assert.equal(inv.subtotal, 150000);
});

test('the contract runs twelve months from its start date', () => {
  assert.deepEqual(contractPeriod('2026-10-01', 12), { start: '2026-10-01', end: '2027-10-01' });
  assert.deepEqual(contractPeriod('2026-11-15', DEFAULT_CONTRACT.months), { start: '2026-11-15', end: '2027-11-15' });
  assert.equal(contractPeriod('2026-02-30', 12), null);
  assert.equal(contractPeriod('15/11/2026', 12), null);
});
