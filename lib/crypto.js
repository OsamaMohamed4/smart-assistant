// Field-level encryption for sensitive PII at rest + PII redaction for logs
// (Task #5, PDPL baseline).
//
// AES-256-GCM (authenticated encryption): tampering is detected on decrypt.
// Key from DATA_ENCRYPTION_KEY (32 bytes as hex[64] or base64). Ciphertext is
// versioned (`v1:iv:tag:ct`, all base64) so keys can be rotated later.
//
// Fail-open in dev: with no key set, encrypt() returns plaintext and isEnabled()
// is false — so local/CI keep working. In production, set the key and encrypt
// the sensitive columns (phone numbers, transcripts, recording URLs).
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';

function loadKey(env = process.env) {
  const raw = env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (hex 64 chars or base64)');
  return key;
}

function isEnabled(env = process.env) { return !!env.DATA_ENCRYPTION_KEY; }
function isEncrypted(value) { return typeof value === 'string' && value.startsWith(PREFIX + ':'); }

function encrypt(plaintext, env = process.env) {
  if (plaintext == null) return plaintext;
  const key = loadKey(env);
  if (!key) return plaintext; // no key → passthrough (dev/CI)
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(value, env = process.env) {
  if (!isEncrypted(value)) return value; // plaintext / null → passthrough
  const key = loadKey(env);
  if (!key) throw new Error('DATA_ENCRYPTION_KEY not set but value is encrypted');
  const [, ivB64, tagB64, ctB64] = value.split(':');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// ── PII redaction for logs / traces (never log a full phone/email) ──────────
function redactPhone(s) {
  return String(s == null ? '' : s).replace(/\+?\d[\d\s-]{5,}\d/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 6 ? `${d.slice(0, 3)}***${d.slice(-2)}` : '***';
  });
}
function redactPII(obj) {
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = (/phone|caller|mobile|email|transcript/i.test(k) && typeof v === 'string') ? redactPhone(v) : v;
  }
  return out;
}

module.exports = { encrypt, decrypt, isEncrypted, isEnabled, loadKey, redactPhone, redactPII, PREFIX };
