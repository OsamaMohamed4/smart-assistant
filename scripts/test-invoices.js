// Monthly invoices end to end on a throwaway SQLite DB: the contract on a
// company, a month built from real call rows, issuing once with a number,
// sending by e-mail (nodemailer's JSON transport, no network), the monthly
// run's window, and the mailer's Arabic explanations.
//
//   node --test scripts/test-invoices.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-invoices-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;
process.env.SMTP_HOST = 'smtp.example.test';
process.env.SMTP_USER = 'info@getmasar.sa';
process.env.SMTP_PASS = 'x';

const { sql, db } = require('../db');
const invoices = require('../services/invoices');
const mailer = require('../lib/mailer');
const nodemailer = require('nodemailer');
const { invalidateCache, loadCompany, listCompaniesFull } = require('../companies');

const outbox = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
mailer._setSmtpTransport({ sendMail: async (m) => { const r = await jsonTransport.sendMail(m); outbox.push(JSON.parse(r.message)); return r; } });

const deps = { sql, listCompanies: listCompaniesFull };
const CONTRACT = { startDate: '2026-09-15', billingEmails: ['billing@maheer.sa'], autoSend: true };
const setContract = (c) => {
  const v = invoices.validateContract(c);
  if (v.error) throw new Error(v.error);
  db.prepare("UPDATE companies SET settings = json_set(COALESCE(settings, '{}'), '$.contract', json(?)) WHERE id = 'maheer'").run(JSON.stringify(v.contract));
  invalidateCache();
};
let seq = 0;
function call(direction, sec, at) {
  db.prepare("INSERT INTO calls (id, company_id, direction, duration_sec, created_at) VALUES (?, 'maheer', ?, ?, ?)")
    .run(`c${++seq}`, direction, sec, at);
}

before(() => {
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('maheer', 'مهير العقارية', 'ar', '')").run();
  setContract(CONTRACT);
  // September (from the 15th): 2,200 one-unit calls, plus some that do not count.
  for (let i = 0; i < 2200; i++) call('outbound', 90, '2026-09-20 10:00:00');
  call('outbound', 30, '2026-09-20 10:00:00');          // under a minute
  call('outbound', 0, '2026-09-20 10:00:00');           // not answered
  call('outbound', 600, '2026-09-14 10:00:00');         // before the contract started
  call('inbound', 300, '2026-09-21 10:00:00');
  // October: 100 one-unit calls and 20 five-minute calls (2 units each).
  for (let i = 0; i < 100; i++) call('outbound', 120, '2026-10-05 09:00:00');
  for (let i = 0; i < 20; i++) call('outbound', 300, '2026-10-06 09:00:00');
  call('inbound', 3600, '2026-10-07 09:00:00');
  // 21:30 UTC on 31 October is 1 November in Riyadh: next month's call.
  call('outbound', 90, '2026-10-31 21:30:00');
});
after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

test('the first month starts at the contract start, and calls before it do not count', async () => {
  const b = await invoices.buildInvoice(await loadCompany('maheer'), '2026-09', deps);
  assert.equal(b.invoice.period.from, '2026-09-15');
  assert.equal(b.invoice.period.to, '2026-09-30');
  assert.equal(b.invoice.computed.outbound.calls, 2202);
  assert.equal(b.invoice.computed.outbound.units, 2200);
  assert.equal(b.invoice.computed.outbound.includedLeft, 50);
  assert.equal(b.invoice.computed.total, 0);
  assert.equal(b.invoice.computed.inbound.calls, 1);
});

test('the next month uses up the rest of the included calls, then bills the extra', async () => {
  const b = await invoices.buildInvoice(await loadCompany('maheer'), '2026-10', deps);
  const c = b.invoice.computed;
  assert.equal(c.outbound.units, 140);                  // 100 + 20 × 2; the 31 Oct 21:30 UTC call is November's
  assert.equal(c.outbound.includedUsed, 50);
  assert.equal(c.outbound.extra, 90);
  assert.equal(c.total, 90 * 170);                      // 153.00 SAR
  assert.equal(b.invoice.contract.endDate, '2027-09-14');
});

test('a month outside the contract has no invoice', async () => {
  const b = await invoices.buildInvoice(await loadCompany('maheer'), '2026-08', deps);
  assert.match(b.error, /خارج مدة العقد/);
});

test('issuing takes a number, happens once, and keeps its snapshot when the contract changes', async () => {
  const company = await loadCompany('maheer');
  const a = await invoices.issueInvoice(company, '2026-10', deps, { actor: 'su@test' });
  assert.match(a.invoice.number, /^MSR-\d{4}-0001$/);
  assert.equal(a.invoice.total, 15300);
  const again = await invoices.issueInvoice(company, '2026-10', deps);
  assert.equal(again.existed, true);
  assert.equal(again.invoice.id, a.invoice.id);
  const nextMonth = await invoices.issueInvoice(company, '2026-09', deps);
  assert.match(nextMonth.invoice.number, /-0002$/);

  setContract({ ...CONTRACT, tiers: [{ upTo: 10000, price: 9.99 }] });
  try {
    const stored = JSON.parse((await sql.getInvoice.get(a.invoice.id)).data);
    assert.equal(stored.computed.total, 15300);
    assert.equal(stored.contract.tiers[0].price, 1.7);
  } finally { setContract(CONTRACT); }
});

test('sending e-mails the invoice to the billing address and records it', async () => {
  outbox.length = 0;
  const company = await loadCompany('maheer');
  const row = await sql.getInvoiceForMonth.get('maheer', '2026-10');
  const r = await invoices.sendInvoice(row, company, deps, { siteUrl: 'https://www.getmasar.sa' });
  assert.equal(r.ok, true);
  assert.equal(outbox.length, 1);
  const m = outbox[0];
  assert.deepEqual(m.to.map((x) => x.address), ['billing@maheer.sa']);
  assert.equal(m.from.address, 'info@getmasar.sa');
  assert.match(m.subject, /أكتوبر 2026/);
  assert.match(m.html, /153\.00/);
  assert.match(m.html, /مهير العقارية/);
  assert.match(m.html, /www\.getmasar\.sa\/login/);
  assert.match(m.text, /الإجمالي: 153\.00/);
  const after = await sql.getInvoice.get(row.id);
  assert.equal(after.status, 'sent');
  assert.equal(after.sent_to, 'billing@maheer.sa');
  assert.ok(after.sent_at);
});

test('with no billing address the send is recorded as failed, with the reason', async () => {
  setContract({ ...CONTRACT, billingEmails: [], autoSend: false });
  try {
    const row = await sql.getInvoiceForMonth.get('maheer', '2026-09');
    const r = await invoices.sendInvoice(row, await loadCompany('maheer'), deps);
    assert.equal(r.ok, false);
    const after = await sql.getInvoice.get(row.id);
    assert.equal(after.status, 'failed');
    assert.match(after.error, /بريد فوترة/);
  } finally { setContract(CONTRACT); }
});

test('the monthly run sends last month in the first days of the month, once', async () => {
  outbox.length = 0;
  db.prepare("DELETE FROM invoices WHERE month = '2026-10'").run();
  // 1 November 2026, 10:00 Riyadh.
  const r = await invoices.monthlyRun(deps, new Date('2026-11-01T07:00:00Z'));
  assert.equal(r.month, '2026-10');
  assert.deepEqual(r.done, [{ company: 'maheer', month: '2026-10', ok: true, error: null }]);
  assert.equal(outbox.length, 1);
  const again = await invoices.monthlyRun(deps, new Date('2026-11-01T09:00:00Z'));
  assert.deepEqual(again.done, []);
  assert.equal(outbox.length, 1);
});

test('outside the window the monthly run does nothing', async () => {
  assert.ok((await invoices.monthlyRun(deps, new Date('2026-11-01T04:00:00Z'))).skipped);   // 07:00 Riyadh
  assert.ok((await invoices.monthlyRun(deps, new Date('2026-11-06T09:00:00Z'))).skipped);   // the 6th
});

test('the contract form is checked before it is stored', () => {
  assert.match(invoices.validateContract({ startDate: '2026-13-01' }).error, /تاريخ/);
  assert.match(invoices.validateContract({ startDate: '2026-10-01', billingEmails: 'not-an-email' }).error, /بريد/);
  assert.match(invoices.validateContract({ startDate: '2026-10-01', tiers: [{ upTo: 100, price: 1 }, { upTo: 50, price: 1 }] }).error, /شرائح/);
  assert.match(invoices.validateContract({ autoSend: true }).error, /تلقائي/);
  const ok = invoices.validateContract({ startDate: '2026-10-01', billingEmails: 'a@x.sa, b@x.sa', vat: 'add' }).contract;
  assert.deepEqual(ok.billingEmails, ['a@x.sa', 'b@x.sa']);
  assert.equal(ok.includedOutboundCalls, 2250);
  assert.deepEqual(ok.tiers.map((t) => t.price), [1.7, 1.5, 1.3]);
  assert.equal(ok.vat, 'add');
});

test('a mailbox Microsoft refuses is explained in Arabic, with what to do', () => {
  assert.match(mailer.explain(new Error('535 5.7.139 Authentication unsuccessful, basic authentication is disabled.')), /Entra|MS_TENANT_ID/);
  assert.match(mailer.explain(new Error('535 5.7.3 Authentication unsuccessful')), /SMTP_PASS/);
  assert.match(mailer.explain(new Error('connect ETIMEDOUT 1.2.3.4:587')), /تعذّر الاتصال/);
});
