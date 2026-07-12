// Daily usage caps (cost control). The usage_counters table existed since
// day one but nothing enforced it — a runaway integration loop could burn
// OpenAI/Vapi budget for days. Caps are generous (normal operation never
// hits them); they're a circuit breaker, not a billing feature.
// Per-company override via settings (dailyMessageCap / dailyOutboundCap),
// platform default via env (DAILY_MSG_CAP / DAILY_OUTBOUND_CAP).
const { sql } = require('../db');

function dailyCap(company, settingsKey, envKey, dflt) {
  const s = Number(company?.settings?.[settingsKey]);
  if (Number.isFinite(s) && s > 0) return s;
  const e = Number(process.env[envKey]);
  if (Number.isFinite(e) && e > 0) return e;
  return dflt;
}

// Atomically consume `amount` from a company's daily budget for `kind`.
// Returns false (without consuming) when the cap would be exceeded.
function checkAndBumpUsage(companyId, kind, cap, amount = 1) {
  const day = new Date().toISOString().slice(0, 10);
  const used = sql.getUsage.get(companyId, day, kind)?.amount || 0;
  if (used + amount > cap) return false;
  sql.bumpUsage.run({ company_id: companyId, day, kind, amount });
  return true;
}

module.exports = { dailyCap, checkAndBumpUsage };
