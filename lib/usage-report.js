// Monthly consumption per company -- inbound and outbound calls apart -- for
// the usage page and whatever bills from it later.
//
// A month is a SAUDI calendar month. The companies and their callers are in
// Riyadh (UTC+3, no DST), so a call at 00:30 on the 1st local time belongs to
// the new month even though UTC still calls it the last day of the old one.
// companies.js applies the same offset to the {{date}} the agent speaks.
const TZ_OFFSET_HOURS = 3;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

// 'YYYY-MM-DD HH:MM:SS' UTC -- the calls.created_at storage format on both drivers.
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** The current Saudi month, as YYYY-MM. */
function currentSaudiMonth(now = new Date()) {
  const local = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The UTC bounds of a Saudi month, in storage format. `to` is EXCLUSIVE -- the
 * first instant of the next month -- matching usageByCompanyInRange. Null for
 * anything that is not a real YYYY-MM.
 */
function saudiMonthRange(month) {
  const m = MONTH_RE.exec(String(month || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  const offset = TZ_OFFSET_HOURS * 3600 * 1000;
  return {
    from: stamp(Date.UTC(year, index, 1) - offset),
    to  : stamp(Date.UTC(year, index + 1, 1) - offset),
  };
}

/**
 * Fold the per-company rows into the report. Every company passed in gets a
 * row, zeros included: a report something may bill from must not skip a
 * client for a quiet month. Credits are the voice provider's own billing
 * unit, so they are included only when the caller says the viewer may see
 * them.
 */
function buildUsageReport(rows, companies, { includeCredits = false } = {}) {
  const num = (v) => Number(v) || 0;
  const byCompany = new Map(rows.map((r) => [r.company_id, r]));
  const out = companies.map((c) => {
    const r = byCompany.get(c.id) || {};
    const row = {
      companyId  : c.id,
      companyName: c.name,
      inbound    : { calls: num(r.inbound_calls),  seconds: num(r.inbound_sec) },
      outbound   : { calls: num(r.outbound_calls), seconds: num(r.outbound_sec) },
    };
    if (includeCredits) {
      row.credits = { inbound: num(r.inbound_credits), outbound: num(r.outbound_credits) };
    }
    return row;
  });

  const totals = {
    inbound : { calls: 0, seconds: 0 },
    outbound: { calls: 0, seconds: 0 },
    ...(includeCredits ? { credits: { inbound: 0, outbound: 0 } } : {}),
  };
  for (const r of out) {
    for (const dir of ['inbound', 'outbound']) {
      totals[dir].calls   += r[dir].calls;
      totals[dir].seconds += r[dir].seconds;
      if (includeCredits) totals.credits[dir] += r.credits[dir];
    }
  }
  return { rows: out, totals };
}

module.exports = { currentSaudiMonth, saudiMonthRange, buildUsageReport, TZ_OFFSET_HOURS };
