// Secret audit + fail-safe validation (Task #4).
//
// - Declares every provider/security secret the app uses.
// - checkSecrets(env): pure — returns what's set / missing / malformed.
// - enforceSecretsAtBoot(env): logs a NAMES-ONLY audit (never a value), then:
//     * production  → refuses to start if a REQUIRED secret is missing/invalid
//                     (process.exit(1)), unless SKIP_SECRET_CHECK=1.
//     * dev / test  → warns but continues, so CI + the smoke suite still boot.
//
// Secret VALUES are never logged — only presence and a masked prefix.
const { logger } = require('./logger');

// { key, required, group, validate?(v)->true|reason }
const SPEC = [
  { key: 'OPENAI_API_KEY', required: true, group: 'ai',
    validate: (v) => /^sk-/.test(v) || 'expected to start with "sk-"' },
  { key: 'VAPI_API_KEY', required: true, group: 'voice' },
  { key: 'ELEVENLABS_API_KEY', required: true, group: 'voice' },
  { key: 'VAPI_WEBHOOK_SECRET', required: true, group: 'voice',
    validate: (v) => v.length >= 8 || 'too short (min 8 chars)' },
  { key: 'DATABASE_URL', required: false, group: 'data', // required only under postgres
    validate: (v) => /^postgres(ql)?:\/\//.test(v) || 'expected a postgres:// URL' },
  { key: 'SENTRY_DSN', required: false, group: 'observability' },
  { key: 'METRICS_TOKEN', required: false, group: 'observability' },
  { key: 'BACKUP_S3_BUCKET', required: false, group: 'backup' },
  { key: 'BACKUP_S3_ACCESS_KEY_ID', required: false, group: 'backup' },
  { key: 'BACKUP_S3_SECRET_ACCESS_KEY', required: false, group: 'backup' },
];

function mask(v) {
  if (v === undefined || v === null || String(v) === '') return '(unset)';
  const s = String(v);
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-2)} (len ${s.length})`;
}

function checkSecrets(env = process.env) {
  const pgSelected = (env.DB_DRIVER || 'sqlite') === 'postgres';
  const missing = [];
  const invalid = [];
  const missingOptional = [];
  const report = [];
  for (const s of SPEC) {
    const required = s.required || (s.key === 'DATABASE_URL' && pgSelected);
    const val = env[s.key];
    const present = val !== undefined && String(val).trim() !== '';
    let fmtErr = null;
    if (present && s.validate) {
      const r = s.validate(String(val));
      if (r !== true) fmtErr = r;
    }
    if (!present && required) missing.push(s.key);
    else if (!present) missingOptional.push(s.key);
    if (present && fmtErr) invalid.push(`${s.key} (${fmtErr})`);
    report.push({ key: s.key, group: s.group, required, present, masked: mask(val), fmtErr });
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, missingOptional, report };
}

function enforceSecretsAtBoot(env = process.env, { exit = true } = {}) {
  const r = checkSecrets(env);
  const isProd = env.NODE_ENV === 'production';
  const bypass = env.SKIP_SECRET_CHECK === '1';
  logger.info('secret audit', {
    set: r.report.filter((x) => x.present && !x.fmtErr).map((x) => x.key),
    missing_required: r.missing,
    invalid: r.invalid,
    missing_optional: r.missingOptional.length,
  });
  if (r.ok) return r;
  if (isProd && !bypass) {
    logger.error('secret check FAILED — refusing to start in production', { missing: r.missing, invalid: r.invalid });
    if (exit) process.exit(1);
  } else {
    logger.info('secret check incomplete (non-production or bypassed — continuing)', { missing: r.missing, invalid: r.invalid });
  }
  return r;
}

module.exports = { SPEC, mask, checkSecrets, enforceSecretsAtBoot };
