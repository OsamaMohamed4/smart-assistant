// Consumption per company (the usage page): Saudi month boundaries, the
// inbound/outbound split, and that the SQL agrees with both.
//
// Runs the real statement against a throwaway SQLite DB -- no network.
//
//   node --test scripts/test-usage.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-usage-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;

const { sql, db } = require('../db');
const { currentSaudiMonth, saudiMonthRange, buildUsageReport } = require('../lib/usage-report');

after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

// ─── Saudi months ─────────────────────────────────────────────────
test('a Saudi month starts at 21:00 UTC on the last day of the month before', () => {
  assert.deepEqual(saudiMonthRange('2026-10'), { from: '2026-09-30 21:00:00', to: '2026-10-31 21:00:00' });
});

test('December rolls into the next year, and the upper bound is exclusive', () => {
  assert.deepEqual(saudiMonthRange('2026-12'), { from: '2026-11-30 21:00:00', to: '2026-12-31 21:00:00' });
  assert.deepEqual(saudiMonthRange('2027-01'), { from: '2026-12-31 21:00:00', to: '2027-01-31 21:00:00' });
});

test('anything but a real YYYY-MM is refused rather than guessed at', () => {
  for (const bad of ['2026-13', '2026-00', '2026-1', '26-10', '', null, undefined, '2026-10-01', 'oct']) {
    assert.equal(saudiMonthRange(bad), null, String(bad));
  }
});

test('the current month follows Riyadh, not UTC', () => {
  // 20:59 UTC on 30 Sep is 23:59 in Riyadh: still September.
  assert.equal(currentSaudiMonth(new Date('2026-09-30T20:59:59Z')), '2026-09');
  // 21:00 UTC on 30 Sep is midnight in Riyadh: October has begun.
  assert.equal(currentSaudiMonth(new Date('2026-09-30T21:00:00Z')), '2026-10');
});

// ─── The report shape ─────────────────────────────────────────────
test('every company gets a row, zeros included', () => {
  const r = buildUsageReport(
    [{ company_id: 'co-a', inbound_calls: 2, inbound_sec: 90, outbound_calls: 1, outbound_sec: 45 }],
    [{ id: 'co-a', name: 'أ' }, { id: 'co-b', name: 'ب' }],
  );
  assert.equal(r.rows.length, 2);
  const noWhatsapp = { received: 0, replies: 0, templates: 0, failed: 0 };
  assert.deepEqual(r.rows[1], {
    companyId: 'co-b', companyName: 'ب',
    inbound: { calls: 0, seconds: 0 }, outbound: { calls: 0, seconds: 0 }, whatsapp: noWhatsapp,
  });
  assert.deepEqual(r.totals, { inbound: { calls: 2, seconds: 90 }, outbound: { calls: 1, seconds: 45 }, whatsapp: noWhatsapp });
});

test('WhatsApp counts join each company\'s row and the totals', () => {
  const r = buildUsageReport([], [{ id: 'co-a', name: 'أ' }, { id: 'co-b', name: 'ب' }], {
    whatsappRows: [
      { company_id: 'co-a', received: 7, replies: 6, templates: 2, failed: 1 },
      { company_id: 'co-b', received: 1, replies: 0, templates: 0, failed: 0 },
    ],
  });
  assert.deepEqual(r.rows[0].whatsapp, { received: 7, replies: 6, templates: 2, failed: 1 });
  assert.deepEqual(r.totals.whatsapp, { received: 8, replies: 6, templates: 2, failed: 1 });
});

test('provider credits appear only when the viewer may see them', () => {
  const rows = [{ company_id: 'co-a', inbound_credits: 12.5, outbound_credits: 3 }];
  const companies = [{ id: 'co-a', name: 'أ' }];
  const hidden = buildUsageReport(rows, companies);
  assert.equal('credits' in hidden.rows[0], false);
  assert.equal('credits' in hidden.totals, false);
  const shown = buildUsageReport(rows, companies, { includeCredits: true });
  assert.deepEqual(shown.rows[0].credits, { inbound: 12.5, outbound: 3 });
  assert.deepEqual(shown.totals.credits, { inbound: 12.5, outbound: 3 });
});

// ─── The SQL ──────────────────────────────────────────────────────
for (const [id, name] of [['co-a', 'شركة أ'], ['co-b', 'شركة ب']]) {
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES (?, ?, 'ar-SA', '')").run(id, name);
}
let n = 0;
function call(company, direction, sec, createdAt, credits = null) {
  db.prepare(`INSERT INTO calls (id, company_id, direction, duration_sec, cost_credits, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`conv_usage_${++n}`, company, direction, sec, credits, createdAt);
}

test('inbound and outbound are counted apart, per company, inside the month only', async () => {
  const oct = saudiMonthRange('2026-10');
  call('co-a', 'inbound', 60, '2026-10-05 10:00:00', 4);
  call('co-a', 'inbound', 30, '2026-10-06 10:00:00', 2);
  call('co-a', 'outbound', 45, '2026-10-07 10:00:00', 3);
  call('co-a', 'outbound', 0, '2026-10-07 11:00:00');            // not answered: a call, no time
  call('co-b', 'outbound', 100, '2026-10-08 10:00:00');
  call(null, 'inbound', 500, '2026-10-08 10:00:00');             // never matched to a company
  call('co-a', 'inbound', 999, '2026-09-30 20:59:59');           // 23:59 Riyadh, 30 Sep
  call('co-a', 'inbound', 7, '2026-09-30 21:00:00');             // 00:00 Riyadh, 1 Oct
  call('co-a', 'inbound', 8, '2026-10-31 20:59:59.5');           // last half-second of October
  call('co-a', 'inbound', 999, '2026-10-31 21:00:00');           // 00:00 Riyadh, 1 Nov

  const rows = await sql.usageByCompanyInRange.all({ ...oct, company_id: null });
  const byId = Object.fromEntries(rows.map((r) => [r.company_id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['co-a', 'co-b'], 'the unmatched call is attributed to no one');

  const a = byId['co-a'];
  assert.equal(a.inbound_calls, 4, 'two mid-month, the first minute of the month, the last half-second');
  assert.equal(a.inbound_sec, 60 + 30 + 7 + 8);
  assert.equal(a.outbound_calls, 2);
  assert.equal(a.outbound_sec, 45);
  assert.equal(a.inbound_credits, 6);
  assert.equal(a.outbound_credits, 3);

  const b = byId['co-b'];
  assert.equal(b.inbound_calls, 0);
  assert.equal(b.outbound_calls, 1);
  assert.equal(b.outbound_sec, 100);
});

test('a company filter returns that company alone', async () => {
  const rows = await sql.usageByCompanyInRange.all({ ...saudiMonthRange('2026-10'), company_id: 'co-b' });
  assert.deepEqual(rows.map((r) => r.company_id), ['co-b']);
});
