// Proof suite for secret validation (Task #4).
// Run: node --test scripts/test-secrets.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { checkSecrets, mask } = require('../lib/secrets');

const ROOT = path.join(__dirname, '..');
const FULL = {
  NODE_ENV: 'production', OPENAI_API_KEY: 'sk-abc123',
  ELEVENLABS_API_KEY: 'e', ELEVENLABS_WEBHOOK_SECRET: '12345678',
};
// enforce in a child process so we can observe the real exit code / fail-safe
const enforce = (env, tail = '') =>
  execFileSync(process.execPath, ['-e', `require('./lib/secrets').enforceSecretsAtBoot(${JSON.stringify(env)})${tail}`],
    { cwd: ROOT, stdio: 'pipe' });

test('valid: all required present → ok', () => {
  const r = checkSecrets(FULL);
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
});
test('missing required: OPENAI_API_KEY absent → not ok, named', () => {
  const { OPENAI_API_KEY, ...rest } = FULL;
  const r = checkSecrets(rest);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('OPENAI_API_KEY'));
});
test('invalid format: OPENAI without sk- prefix → invalid', () => {
  const r = checkSecrets({ ...FULL, OPENAI_API_KEY: 'not-a-key' });
  assert.equal(r.ok, false);
  assert.ok(r.invalid.some((s) => s.startsWith('OPENAI_API_KEY')));
});
test('invalid format: short ELEVENLABS_WEBHOOK_SECRET → invalid', () => {
  const r = checkSecrets({ ...FULL, ELEVENLABS_WEBHOOK_SECRET: 'abc' });
  assert.ok(r.invalid.some((s) => s.startsWith('ELEVENLABS_WEBHOOK_SECRET')));
});
// Without a webhook secret the post-call endpoint cannot authenticate anything,
// so an unsigned request could write call rows for any tenant. It must be a
// boot-blocking requirement, not a warning.
test('missing required: ELEVENLABS_WEBHOOK_SECRET absent → not ok, named', () => {
  const { ELEVENLABS_WEBHOOK_SECRET, ...rest } = FULL;
  const r = checkSecrets(rest);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('ELEVENLABS_WEBHOOK_SECRET'));
});
// The KB tool secret is optional (it falls back to the webhook secret), but a
// too-short value must still be rejected rather than silently weakening the
// token that carries a call's tenant identity.
test('optional-but-invalid: a short ELEVENLABS_TOOL_SECRET is reported', () => {
  const r = checkSecrets({ ...FULL, ELEVENLABS_TOOL_SECRET: 'tiny' });
  assert.equal(r.ok, false);
  assert.ok(r.invalid.some((s) => s.startsWith('ELEVENLABS_TOOL_SECRET')));
});
test('no Vapi secret is required any more', () => {
  const r = checkSecrets(FULL);
  assert.ok(!r.missing.some((k) => k.startsWith('VAPI_')), 'VAPI_* must not block boot');
  assert.ok(!r.report.some((x) => x.key.startsWith('VAPI_')), 'VAPI_* is no longer declared at all');
});
test('conditional: DB_DRIVER=postgres without DATABASE_URL → required + missing', () => {
  const r = checkSecrets({ ...FULL, DB_DRIVER: 'postgres' });
  assert.ok(r.missing.includes('DATABASE_URL'));
});
test('masking: never reveals the full secret', () => {
  const m = mask('sk-supersecretvalue12345');
  assert.ok(!m.includes('supersecret'));
  assert.ok(m.includes('…'));
  assert.equal(mask(''), '(unset)');
});

// ── fail-safe behaviour (real child-process exit codes) ──────────
test('fail-safe: production + missing required secret → process exits 1', () => {
  assert.throws(
    () => enforce({ NODE_ENV: 'production' }),
    (e) => e.status === 1,
  );
});
test('safe boot: production + all secrets present → exit 0', () => {
  assert.doesNotThrow(() => enforce(FULL, ';process.exit(0)'));
});
test('non-production + missing secret → does NOT exit (continues)', () => {
  assert.doesNotThrow(() => enforce({ NODE_ENV: 'development' }, ';process.exit(0)'));
});
test('bypass: production + SKIP_SECRET_CHECK=1 + missing → does NOT exit', () => {
  assert.doesNotThrow(() => enforce({ NODE_ENV: 'production', SKIP_SECRET_CHECK: '1' }, ';process.exit(0)'));
});
