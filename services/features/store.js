// Reading and writing per-company capability configuration.
//
// This module is the ONLY answer to "is capability X on for company Y", and
// both the publish pipeline and the live tool endpoint ask it. That matters:
// removing a tool from the agent at publish time is not enforcement, because a
// stale agent version can still call us. The endpoint therefore re-asks on
// EVERY invocation, and gets its answer from here.
const { sql } = require('../../db');
const { getFeature, allFeatures, isImplemented } = require('./registry');

/**
 * Explicit rows only. A capability with no row is NOT absent from the system —
 * it falls back to the registry's `defaultEnabled`, which is what preserves the
 * behaviour of every company configured before this registry existed.
 */
async function loadFeatureRows(companyId) {
  const rows = await sql.listCompanyFeatures.all(companyId);
  const map = new Map();
  for (const r of rows || []) {
    let config = null;
    try { config = r.config ? JSON.parse(r.config) : null; } catch { config = null; }
    map.set(r.feature_key, { enabled: !!Number(r.enabled), config });
  }
  return map;
}

/**
 * Is this capability enabled for this company?
 *
 * Fails CLOSED in every ambiguous case: an unknown key, a capability that is
 * only planned, or a database error all answer false. A capability that cannot
 * be evaluated must not be invokable.
 */
async function featureEnabled(companyId, featureKey) {
  if (!companyId || !featureKey) return false;
  const feature = getFeature(featureKey);
  if (!feature) return false;
  // A planned capability is never enabled, whatever a stale row claims. This is
  // the backstop if a row somehow gets written for one.
  if (feature.status !== 'implemented') return false;
  try {
    const row = await sql.getCompanyFeature.get(companyId, featureKey);
    if (!row) return !!feature.defaultEnabled;
    return !!Number(row.enabled);
  } catch {
    return false;
  }
}

/**
 * Every capability with its effective state for one company — what the admin UI
 * renders and what the publish pipeline plans from.
 *
 * `ctx` carries the facts `requires` needs (kb chunk count, transfer number,
 * public base URL). When omitted, `available` is reported as null rather than
 * guessed.
 */
async function describeFeatures(companyId, ctx = null) {
  const rows = await loadFeatureRows(companyId);
  return allFeatures().map((f) => {
    const row = rows.get(f.key);
    const configured = row ? row.enabled : null;      // null = never set explicitly
    const enabled = f.status === 'implemented'
      ? (row ? row.enabled : !!f.defaultEnabled)
      : false;

    let available = null;
    let reason = null;
    if (ctx && f.status === 'implemented' && f.requires) {
      const r = f.requires(ctx);
      available = r === true;
      if (r !== true) reason = r;
    } else if (ctx && f.status === 'implemented') {
      available = true;
    }

    return {
      key: f.key,
      labelAr: f.labelAr,
      descriptionAr: f.descriptionAr || '',
      status: f.status,
      kind: f.kind,
      enabled,
      configured,
      defaultEnabled: !!f.defaultEnabled,
      available,
      reason,
      config: row?.config || null,
    };
  });
}

/**
 * Turn a capability on or off for one company.
 * @returns {{ok:true}|{ok:false,error:string,code:string}}
 */
async function setFeature(companyId, featureKey, enabled, config = null) {
  const feature = getFeature(featureKey);
  if (!feature) {
    return { ok: false, code: 'UNKNOWN_FEATURE', error: `قدرة غير معروفة: ${featureKey}` };
  }
  // The rule that keeps a half-built capability away from callers: it cannot be
  // switched on at all, so it can never be planned into a tool.
  if (enabled && !isImplemented(featureKey)) {
    return {
      ok: false, code: 'NOT_IMPLEMENTED',
      error: `القدرة «${feature.labelAr}» غير متاحة بعد.`,
    };
  }
  await sql.upsertCompanyFeature.run({
    company_id : companyId,
    feature_key: featureKey,
    enabled    : enabled ? 1 : 0,
    config     : config ? JSON.stringify(config) : null,
  });
  return { ok: true };
}

/**
 * Build the publish plan: which capabilities get a tool, and which are held
 * back and why. Pure decision-making — nothing here talks to a provider.
 */
async function planCapabilities(companyId, ctx) {
  const described = await describeFeatures(companyId, ctx);
  const attach = [];
  const skipped = [];
  for (const f of described) {
    if (f.status !== 'implemented') continue;          // never planned
    if (!f.enabled) { skipped.push({ key: f.key, reason: 'disabled' }); continue; }
    if (f.available === false) { skipped.push({ key: f.key, reason: f.reason }); continue; }
    attach.push(f.key);
  }
  return { attach, skipped, described };
}

/** Tool ids already registered for this company, keyed by capability. */
async function loadTools(companyId) {
  const rows = await sql.listCompanyTools.all(companyId);
  const map = new Map();
  for (const r of rows || []) {
    map.set(r.feature_key, { toolId: r.elevenlabs_tool_id, configHash: r.config_hash || null });
  }
  return map;
}

module.exports = {
  featureEnabled, describeFeatures, setFeature, planCapabilities,
  loadFeatureRows, loadTools,
};
