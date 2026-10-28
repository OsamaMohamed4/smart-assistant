// A month of WhatsApp on the invoice: the company's package, and what went
// beyond it.
//
// The packages are the client's own table (relayed 2026-10-28), which it
// calls the reference for invoicing: a monthly price covering a number of
// conversations and of messages, and a price for each conversation and each
// message beyond them. Enterprise is "special pricing by agreement", so its
// figures are entered per company.
//
// How the excess is counted, from the client's worked example: on Lite (1,000
// conversations, 8,000 messages), 1,100 conversations cost 100 × 0.60 = 60
// SAR more, "assuming each extra conversation is no more than 8 messages",
// and messages beyond what is included are billed at the message price. So
// every extra conversation brings its share of messages with it -- the
// package's messages per conversation, 8 in every package -- and only the
// messages beyond that grown allowance are billed. Pooled, not per
// conversation: one short conversation offsets a long one.
//
// What a conversation and a message are, as the platform can see them:
//   - a conversation is one customer number over 24 hours from its first
//     message (WhatsApp's own unit), and it counts when the platform sent
//     something in it -- the assistant's reply or a message after a call. One
//     the assistant never answered (outside reply hours, or taken by staff
//     from the first message) is not the platform's to bill.
//   - its messages are all of them, the customer's and the platform's;
//     a send that failed is not a message.
//   - a conversation belongs to the month it started in, its messages with it.
// Staff replies written in LoopChat never reach the platform, so they are in
// no count.
//
// Prices go down to fractions of a halala (5.625), so money here is counted in
// thousandths of a halala and only rounded, to the halala, per line.

const PACKAGES = Object.freeze({
  lite    : Object.freeze({ labelAr: 'Lite',     monthlyFee: 600,  conversations: 1000,  messages: 8000,  extraConversation: 0.60, extraMessage: 0.075 }),
  starter : Object.freeze({ labelAr: 'Starter',  monthlyFee: 1250, conversations: 2500,  messages: 20000, extraConversation: 0.50, extraMessage: 0.0625 }),
  growth  : Object.freeze({ labelAr: 'Growth',   monthlyFee: 2250, conversations: 5000,  messages: 40000, extraConversation: 0.45, extraMessage: 0.05625 }),
  business: Object.freeze({ labelAr: 'Business', monthlyFee: 4000, conversations: 10000, messages: 80000, extraConversation: 0.40, extraMessage: 0.05 }),
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
    monthlyFee: price(c.monthlyFee), conversations: int(c.conversations), messages: int(c.messages),
    extraConversation: price(c.extraConversation), extraMessage: price(c.extraMessage),
  };
  if (Object.values(custom).some((v) => v === null)) {
    return { error: 'أكمل أرقام باقة Enterprise: السعر الشهري، والمحادثات والرسائل المشمولة، وسعر المحادثة والرسالة الإضافية' };
  }
  return { whatsapp: { package: ENTERPRISE, custom } };
}

/**
 * Conversations and their messages for [from, to), from the company's
 * WhatsApp messages: each { contact_phone, created_at, direction }, only
 * those that count (received, or sent and delivered to LoopChat), ordered by
 * number then time, and reaching back far enough for every number active in
 * the month that a conversation open at its start is seen whole.
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

/** The month's WhatsApp, priced. Amounts in halalas. */
function compute(terms, { conversations = 0, messages = 0 } = {}) {
  const extraConversations = Math.max(0, conversations - terms.conversations);
  // Each extra conversation brings the package's messages per conversation.
  const perConversation = terms.conversations > 0 ? terms.messages / terms.conversations : 0;
  const messageAllowance = terms.messages + Math.floor(extraConversations * perConversation);
  const extraMessages = Math.max(0, messages - messageAllowance);
  const fee = toHalalas(milli(terms.monthlyFee));
  const lines = [];
  if (extraConversations) {
    lines.push({ key: 'conversations', units: extraConversations, unitPrice: milli(terms.extraConversation),
      amount: toHalalas(extraConversations * milli(terms.extraConversation)) });
  }
  if (extraMessages) {
    lines.push({ key: 'messages', units: extraMessages, unitPrice: milli(terms.extraMessage),
      amount: toHalalas(extraMessages * milli(terms.extraMessage)) });
  }
  return {
    package: terms.package, labelAr: terms.labelAr,
    included: { conversations: terms.conversations, messages: terms.messages },
    conversations, messages, extraConversations, messageAllowance, extraMessages,
    fee, lines,
    total: fee + lines.reduce((n, l) => n + l.amount, 0),
  };
}

/** A unit price in thousandths of a halala, as SAR with as many decimals as it needs: 0.075. */
function unitSar(m) {
  return (m / 100000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

module.exports = { PACKAGES, ENTERPRISE, termsOf, validate, countConversations, compute, unitSar, milli };
