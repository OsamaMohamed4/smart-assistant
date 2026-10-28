// The monthly invoice, computed from a company's contract and its calls.
//
// The contract (client's own table, confirmed by the operator 2026-10-16):
//   - 12 months; inbound calls unlimited (never billed).
//   - 2,250 outbound calls included for the WHOLE contract, used up first.
//   - After that, extra outbound calls are billed every month in graduated
//     tiers that start again each month: the first 10,000 extra calls of the
//     month at 1.70 SAR, the next up to 50,000 at 1.50, the next up to 100,000
//     at 1.30; beyond 100,000 by a special quote (counted, never priced here).
//   - "One call" is a call of one to four minutes: a call under a minute is
//     not counted, and every started four minutes counts as one call (4:01 is
//     two).
//
// Everything is in halalas (integers) so 1.70 × 3 is 510, never 509.99999.
// No I/O here: the caller hands in the durations, this decides the money.

const DEFAULT_CONTRACT = Object.freeze({
  months: 12,
  includedOutboundCalls: 2250,
  minBillableSeconds: 60,
  unitSeconds: 240,
  // upTo is the last extra call of the month the price applies to.
  tiers: Object.freeze([
    Object.freeze({ upTo: 10000, price: 1.70 }),
    Object.freeze({ upTo: 50000, price: 1.50 }),
    Object.freeze({ upTo: 100000, price: 1.30 }),
  ]),
  monthlyFee: 0,        // a fixed amount per month, when the contract has one
  whatsapp: null,       // { package } -- see lib/whatsapp-billing.js; null: WhatsApp not billed
  vat: 'none',          // 'none' | 'add' (prices are before VAT; VAT is added on top)
  vatRate: 15,
});

const halalas = (sar) => Math.round(Number(sar) * 100);

/** How many contract "calls" one outbound call counts as. */
function callUnits(durationSec, c = DEFAULT_CONTRACT) {
  const d = Number(durationSec) || 0;
  if (d < c.minBillableSeconds) return 0;
  return Math.ceil(d / c.unitSeconds);
}

/** Total units for a list of durations. */
function unitsFor(durations, c = DEFAULT_CONTRACT) {
  return durations.reduce((n, d) => n + callUnits(d, c), 0);
}

/**
 * Price a month's extra calls through the graduated tiers. Returns the priced
 * lines and the count beyond the last tier, which only a special quote prices.
 */
function priceExtra(extra, tiers = DEFAULT_CONTRACT.tiers) {
  const lines = [];
  let remaining = Math.max(0, Math.floor(extra));
  let prev = 0;
  for (const t of tiers) {
    if (remaining <= 0) break;
    const n = Math.min(remaining, t.upTo - prev);
    if (n > 0) {
      const unit = halalas(t.price);
      lines.push({ from: prev + 1, to: prev + n, units: n, unitPrice: unit, amount: n * unit });
      remaining -= n;
    }
    prev = t.upTo;
  }
  return { lines, beyondTiers: remaining };
}

/**
 * One month's invoice.
 *   unitsBefore     units of all outbound calls from the contract start up to this month
 *   monthDurations  durations (seconds) of this month's outbound calls
 *   inbound         { calls, seconds } for the month, shown but never billed
 *   whatsapp        the month's WhatsApp already priced (lib/whatsapp-billing.js
 *                   compute()), or null when the contract has no WhatsApp package
 */
function computeInvoice({ contract = DEFAULT_CONTRACT, unitsBefore = 0, monthDurations = [], inbound = { calls: 0, seconds: 0 }, whatsapp = null }) {
  const c = { ...DEFAULT_CONTRACT, ...contract };
  const units = unitsFor(monthDurations, c);
  const answered = monthDurations.filter((d) => (Number(d) || 0) > 0).length;
  const billableCalls = monthDurations.filter((d) => callUnits(d, c) > 0).length;
  const includedLeftBefore = Math.max(0, c.includedOutboundCalls - unitsBefore);
  const includedUsed = Math.min(units, includedLeftBefore);
  const extra = units - includedUsed;
  const { lines, beyondTiers } = priceExtra(extra, c.tiers);

  const usage = lines.reduce((n, l) => n + l.amount, 0);
  const fee = halalas(c.monthlyFee || 0);
  const subtotal = usage + fee + (whatsapp ? whatsapp.total : 0);
  const vat = c.vat === 'add' ? Math.round((subtotal * Number(c.vatRate || 0)) / 100) : 0;

  return {
    outbound: {
      calls: monthDurations.length,          // every outbound call placed
      answered,                              // that connected at all
      billableCalls,                         // a minute or longer
      units,                                 // contract "calls" they count as
      includedUsed,
      includedLeft: includedLeftBefore - includedUsed,
      extra,
      beyondTiers,                           // above the last tier: special quote
    },
    inbound: { calls: inbound.calls || 0, seconds: inbound.seconds || 0 },
    lines,                                   // the priced tiers
    whatsapp,                                // package, counts and its own lines; null if not billed
    monthlyFee: fee,
    subtotal,
    vat,
    vatRate: c.vat === 'add' ? Number(c.vatRate || 0) : 0,
    total: subtotal + vat,
    needsQuote: beyondTiers > 0,
  };
}

/**
 * The contract's bounds in Saudi time: [start, end) as YYYY-MM-DD, end
 * exclusive, from a start date and a length in months.
 */
function contractPeriod(startDate, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startDate || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3]);
  const start = new Date(Date.UTC(y, mo, d));
  if (start.getUTCMonth() !== mo || start.getUTCDate() !== d) return null;
  const end = new Date(Date.UTC(y, mo + Number(months || 12), d));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Halalas to "1,234.50". */
function sar(h) {
  return (Number(h || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { DEFAULT_CONTRACT, callUnits, unitsFor, priceExtra, computeInvoice, contractPeriod, sar, halalas };
