// WhatsApp on the monthly invoice: the client's packages, its worked example,
// what counts as a conversation and a message, and the lines on the invoice.
//
// The counting and the money on numbers; then a month of real
// whatsapp_messages rows through buildInvoice on a throwaway SQLite DB.
//
//   node --test scripts/test-whatsapp-billing.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-wabill-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;

const wa = require('../lib/whatsapp-billing');
const { sar } = require('../lib/invoice');
let sql; let db; let invoices; let companies;

before(() => {
  ({ sql, db } = require('../db'));
  invoices = require('../services/invoices');
  companies = require('../companies');
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('wakan', 'وكن', 'ar', '')").run();
});
after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

const lite = wa.termsOf({ whatsapp: { package: 'lite' } });

// ─── The money ────────────────────────────────────────────────────
test("the client's example: Lite, 1,100 conversations of 8 messages, is 600 + 100 × 0.60", () => {
  const m = wa.compute(lite, { conversations: 1100, messages: 8800 });
  assert.equal(m.extraConversations, 100);
  assert.equal(m.messageAllowance, 8800, 'each extra conversation brings its 8 messages');
  assert.equal(m.extraMessages, 0);
  assert.deepEqual(m.lines.map((l) => [l.key, l.units, sar(l.amount)]), [['conversations', 100, '60.00']]);
  assert.equal(sar(m.fee), '600.00');
  assert.equal(sar(m.total), '660.00');
});

test('messages beyond the allowance are billed at the package price, to the fraction of a halala', () => {
  const m = wa.compute(lite, { conversations: 1100, messages: 9000 });
  assert.equal(m.extraMessages, 200);
  assert.equal(sar(m.lines[1].amount), '15.00');            // 200 × 0.075
  const growth = wa.compute(wa.termsOf({ whatsapp: { package: 'growth' } }), { conversations: 10, messages: 41000 });
  assert.equal(growth.extraMessages, 1000);
  assert.equal(sar(growth.lines[0].amount), '56.25');       // 1,000 × 0.05625, exactly
  assert.equal(wa.unitSar(growth.lines[0].unitPrice), '0.05625');
});

test('inside the package only its monthly price is due, for every package in the table', () => {
  const table = { lite: [600, 1000, 8000], starter: [1250, 2500, 20000], growth: [2250, 5000, 40000], business: [4000, 10000, 80000] };
  for (const [k, [fee, conv, msgs]] of Object.entries(table)) {
    const m = wa.compute(wa.termsOf({ whatsapp: { package: k } }), { conversations: conv, messages: msgs });
    assert.equal(m.total, fee * 100, k);
    assert.deepEqual(m.lines, [], k);
  }
  assert.deepEqual(Object.values(wa.PACKAGES).map((p) => [p.extraConversation, p.extraMessage]),
    [[0.60, 0.075], [0.50, 0.0625], [0.45, 0.05625], [0.40, 0.05]]);
});

test('Enterprise is priced by agreement: every figure must be entered', () => {
  assert.match(wa.validate({ package: 'enterprise', custom: { monthlyFee: 9000 } }).error, /Enterprise/);
  const v = wa.validate({ package: 'enterprise', custom: { monthlyFee: 9000, conversations: 20000, messages: 160000, extraConversation: 0.35, extraMessage: 0.045 } });
  const m = wa.compute(wa.termsOf(v), { conversations: 20001, messages: 160000 });
  assert.equal(sar(m.total), '9,000.35');
  assert.equal(wa.validate({ package: '' }).whatsapp, null, 'no package: WhatsApp is not billed');
  assert.match(wa.validate({ package: 'gold' }).error, /غير معروفة/);
});

// ─── What counts ──────────────────────────────────────────────────
const msg = (phone, at, direction = 'in') => ({ contact_phone: phone, created_at: at, direction });
const OCT = { from: '2026-09-30 21:00:00', to: '2026-10-31 21:00:00' };   // October, Riyadh time
const count = (rows) => wa.countConversations(rows, OCT.from, OCT.to);

test('a conversation is a number over 24 hours, counted when the assistant sent something in it', () => {
  assert.deepEqual(count([
    msg('a', '2026-10-05 08:00:00'), msg('a', '2026-10-05 08:00:05', 'out'),
    msg('a', '2026-10-05 20:00:00'), msg('a', '2026-10-05 20:00:04', 'out'),   // same 24 hours
    msg('a', '2026-10-06 09:00:00'), msg('a', '2026-10-06 09:00:03', 'out'),   // 25 hours on: a new one
  ]), { conversations: 2, messages: 6 });
  // Never answered (outside reply hours, or staff from the first message): not billed.
  assert.deepEqual(count([msg('b', '2026-10-07 08:00:00'), msg('b', '2026-10-07 08:05:00')]), { conversations: 0, messages: 0 });
  // A message after a call opens one too.
  assert.deepEqual(count([msg('c', '2026-10-08 12:00:00', 'out')]), { conversations: 1, messages: 1 });
});

test('a conversation belongs to the month it started in, with its messages', () => {
  assert.deepEqual(count([
    msg('a', '2026-09-30 20:00:00'), msg('a', '2026-09-30 20:00:05', 'out'),   // September, Riyadh 23:00
    msg('a', '2026-09-30 22:00:00'), msg('a', '2026-09-30 22:00:04', 'out'),   // October, but September's conversation
    msg('a', '2026-10-01 21:00:00'), msg('a', '2026-10-01 21:00:03', 'out'),   // 25 hours after it began: October's
  ]), { conversations: 1, messages: 2 });
  // Started in October, running into November: October's, whole.
  assert.deepEqual(count([msg('d', '2026-10-31 20:00:00'), msg('d', '2026-10-31 22:00:00', 'out')]), { conversations: 1, messages: 2 });
});

// ─── On the invoice ───────────────────────────────────────────────
function waRow(phone, at, direction, status = direction === 'in' ? 'received' : 'sent', kind = 'text') {
  db.prepare(`INSERT INTO whatsapp_messages (company_id, channel_id, contact_phone, direction, kind, status, created_at)
              VALUES ('wakan', 182, ?, ?, ?, ?, ?)`).run(phone, direction, kind, status, at);
}

test('a contract with a package puts WhatsApp on the invoice; one without leaves it off', async () => {
  const contract = { startDate: '2026-09-01', billingEmails: ['billing@wakan.sa'], whatsapp: { package: 'lite' } };
  const v = invoices.validateContract(contract);
  assert.ifError(v.error);
  db.prepare("UPDATE companies SET settings = ? WHERE id = 'wakan'").run(JSON.stringify({ contract: v.contract }));
  companies.invalidateCache();

  waRow('966500000001', '2026-10-03 09:00:00', 'in');
  waRow('966500000001', '2026-10-03 09:00:04', 'out');
  waRow('966500000001', '2026-10-03 09:01:00', 'out', 'failed');           // never sent: not a message
  waRow('966500000002', '2026-10-04 10:00:00', 'in');
  waRow('966500000002', '2026-10-04 10:00:01', 'out', 'skipped');          // outside reply hours: not served
  waRow('966500000003', '2026-10-05 11:00:00', 'out', 'sent', 'template');  // after a call

  const b = await invoices.buildInvoice(await companies.loadCompany('wakan'), '2026-10', { sql });
  const w = b.invoice.computed.whatsapp;
  assert.equal(w.package, 'lite');
  assert.equal(w.conversations, 2);
  assert.equal(w.messages, 3);
  assert.equal(b.invoice.computed.subtotal, 60000, 'the package price, on top of the calls');
  assert.equal(b.invoice.contract.whatsapp.labelAr, 'Lite');

  const html = invoices.renderInvoiceHtml({ ...b.invoice, seller: {} });
  assert.match(html, /باقة واتساب Lite/);
  assert.match(html, /واتساب هذا الشهر: 2 محادثة و3 رسالة/);
  assert.match(invoices.renderInvoiceText({ ...b.invoice, seller: {} }), /المحادثة رقم عميل واحد خلال 24 ساعة/);

  // The usage page counts the same conversations.
  const rows = await sql.listWhatsappForBilling.all({ company_id: 'wakan', from: OCT.from, to: OCT.to });
  assert.equal(wa.countConversations(rows, OCT.from, OCT.to).conversations, 2);

  const none = invoices.validateContract({ ...contract, whatsapp: null }).contract;
  db.prepare("UPDATE companies SET settings = ? WHERE id = 'wakan'").run(JSON.stringify({ contract: none }));
  companies.invalidateCache();
  const plain = await invoices.buildInvoice(await companies.loadCompany('wakan'), '2026-10', { sql });
  assert.equal(plain.invoice.computed.whatsapp, null);
  assert.equal(plain.invoice.computed.subtotal, 0);
  assert.doesNotMatch(invoices.renderInvoiceHtml({ ...plain.invoice, seller: {} }), /واتساب/);
});
