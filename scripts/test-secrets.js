// Proof suite for secret validation (Task #4).
// Run: node --test scripts/test-secrets.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { checkSecrets, mask } = require('../lib/secrets');

const ROOT = path.join(__dirname, '..');
const FULL = {
  NODE_ENV: 'production', OPENAI_API_KEY: 'sk-abc123', VAPI_API_KEY: 'v',
  ELEVENLABS_API_KEY: 'e', VAPI_WEBHOOK_SECRET: '12345678',
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
test('invalid format: short VAPI_WEBHOOK_SECRET → invalid', () => {
  const r = checkSecrets({ ...FULL, VAPI_WEBHOOK_SECRET: 'abc' });
  assert.ok(r.invalid.some((s) => s.startsWith('VAPI_WEBHOOK_SECRET')));
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
