// A month of WhatsApp on the invoice: the company's package, and what went
// beyond it.
//
// The packages are the client's own table (relayed 2026-10-28, revised
// 2026-11-04 to message-only billing): a monthly price covering a number of
// messages, and a price for each message beyond them. Enterprise is "special
// pricing by agreement", so its figures are entered per company.
//
// How the excess is counted, from the client's worked example: on Lite (1,000
// messages included for 600 SAR), a customer who used 1,300 messages has 300
// extra, billed at 0.60 SAR each = 180 SAR, so the month's bill is
// 600 + 180 = 780 SAR before VAT. Pooled across the month: there is no
// conversation unit any more, only the month's message total against the
// package's included messages.
//
// What a message is, as the platform can see it (unchanged):
//   - a conversation is one customer number over 24 hours from its first
//     message (WhatsApp's own unit); it counts toward billing only when the
//     platform sent something in it -- the assistant's reply or a message
//     after a call. One the assistant never answered (outside reply hours, or
//     taken by staff from the first message) is not the platform's to bill,
//     and neither are its messages.
//   - a served conversation's messages are all of them, the customer's and
//     the platform's; a send that failed is not a message.
//   - a conversation belongs to the month it started in, its messages with it.
// Staff replies written in LoopChat never reach the platform, so they are in
// no count. The conversation grouping still decides WHICH messages are billed
// and in WHICH month; it is no longer itself a billed unit.
//
// Prices are whole halalas now (0.60, 0.50, ...), but money is still counted
// in thousandths of a halala and rounded to the halala per line, so custom
// Enterprise fractions keep working.

const PACKAGES = Object.freeze({
  lite    : Object.freeze({ labelAr: 'Lite',     monthlyFee: 600,  messages: 1000,  extraMessage: 0.60 }),
  starter : Object.freeze({ labelAr: 'Starter',  monthlyFee: 1250, messages: 2500,  extraMessage: 0.50 }),
  growth  : Object.freeze({ labelAr: 'Growth',   monthlyFee: 2250, messages: 5000,  extraMessage: 0.45 }),
  business: Object.freeze({ labelAr: 'Business', monthlyFee: 4000, messages: 10000, extraMessage: 0.40 }),
});
const ENTERPRISE = 'enterprise';
const DAY_MS = 24 * 3600 * 1000;

// SAR to thousandths of a halala (1e-5 SAR), and back to whole halalas.
const milli = (sar) => Math.round(Number(sar) * 100000);
const toHalalas = (m) => Math.round(m / 1000);

/** The package terms a contract names, or null when WhatsApp is not billed. */
function termsOf(contract) {
  const w = contract?.whatsapp;
  if (!w || !w.package) return null;
  if (PACKAGES[w.package]) return { package: w.package, ...PACKAGES[w.package] };
  if (w.package === ENTERPRISE && w.custom) return { package: ENTERPRISE, labelAr: 'Enterprise', ...w.custom };
  return null;
}

/** What the contract screen sent, checked. Returns { whatsapp } or { error }. */
function validate(b) {
  const pkg = String(b?.package || '').trim();
  if (!pkg) return { whatsapp: null };
  if (PACKAGES[pkg]) return { whatsapp: { package: pkg } };
  if (pkg !== ENTERPRISE) return { error: 'باقة واتساب غير معروفة' };
  const c = b?.custom || {};
  const int = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 100_000_000 ? n : null; };
  const price = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100_000 ? Math.round(n * 100000) / 100000 : null; };
  const custom = {
    monthlyFee: price(c.monthlyFee), messages: int(c.messages), extraMessage: price(c.extraMessage),
  };
  if (Object.values(custom).some((v) => v === null)) {
    return { error: 'أكمل أرقام باقة Enterprise: السعر الشهري، والرسائل المشمولة، وسعر الرسالة الإضافية' };
  }
  return { whatsapp: { package: ENTERPRISE, custom } };
}

/**
 * Conversations and their messages for [from, to), from the company's
 * WhatsApp messages: each { contact_phone, created_at, direction }, only
 * those that count (received, or sent and delivered to LoopChat), ordered by
 * number then time, and reaching back far enough for every number active in
 * the month that a conversation open at its start is seen whole.
 *
 * Billing uses `messages`; `conversations` is returned for reporting only.
 */
function countConversations(rows, from, to) {
  const at = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);
  let conversations = 0;
  let messages = 0;
  let phone = null;
  let cur = null;                       // the conversation being walked
  const close = () => {
    if (cur && cur.served && cur.start >= from && cur.start < to) { conversations += 1; messages += cur.messages; }
  };
  for (const r of rows) {
    const t = at(r.created_at);
    if (!Number.isFinite(t)) continue;
    if (r.contact_phone !== phone || t >= cur.ends) {
      close();
      phone = r.contact_phone;
      cur = { start: r.created_at, ends: t + DAY_MS, served: false, messages: 0 };
    }
    cur.messages += 1;
    if (r.direction === 'out') cur.served = true;
  }
  close();
  return { conversations, messages };
}

/** The month's WhatsApp, priced by messages only. Amounts in halalas. */
function compute(terms, { conversations = 0, messages = 0 } = {}) {
  const extraMessages = Math.max(0, messages - terms.messages);
  const fee = toHalalas(milli(terms.monthlyFee));
  const lines = [];
  if (extraMessages) {
    lines.push({ key: 'messages', units: extraMessages, unitPrice: milli(terms.extraMessage),
      amount: toHalalas(extraMessages * milli(terms.extraMessage)) });
  }
  return {
    package: terms.package, labelAr: terms.labelAr,
    included: { messages: terms.messages },
    conversations, messages, extraMessages,
    fee, lines,
    total: fee + lines.reduce((n, l) => n + l.amount, 0),
  };
}

/** A unit price in thousandths of a halala, as SAR with as many decimals as it needs: 0.60. */
function unitSar(m) {
  return (m / 100000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

module.exports = { PACKAGES, ENTERPRISE, termsOf, validate, countConversations, compute, unitSar, milli };
