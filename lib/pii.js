// Production wiring for the PDPL primitives (audit F-04b).
//
// lib/crypto.js has shipped since the PDPL pass but was imported by nothing
// except its own test — no value was ever encrypted and no log was ever
// redacted. This module is the missing application layer.
//
// ─── Two mechanisms, deliberately different defaults ──────────────
//
// 1. REDACTION — ON by default, always. Masking a phone number before it
//    reaches a log line cannot break anything and cannot lose data. There is
//    no reason to gate it.
//
// 2. COLUMN ENCRYPTION — OFF unless DATA_ENCRYPTION_KEY is set, and reads
//    always tolerate BOTH forms. Encrypting at rest converts "someone reads
//    the DB" into "someone reads the DB AND has the key" — but it also
//    converts "we lost the key" into "we lost the data". Turning this on
//    before a verified backup exists trades a confidentiality risk for an
//    availability risk, which is a bad trade. The code is here, tested, and
//    inert until the key is set.
//
// ─── What is NOT encrypted, and why ───────────────────────────────
//
//   whatsapp_sessions.customer_phone — part of the PRIMARY KEY and looked up
//     by exact value (`WHERE company_id = ? AND customer_phone = ?`).
//     AES-GCM uses a random IV, so the same phone encrypts differently every
//     time and the lookup would never match. Encrypting this needs a blind
//     index (an HMAC column to search on) — a schema change worth doing
//     deliberately, not smuggled into this pass.
//
//   calls.transcript — the Conversations search runs `transcript LIKE ?`.
//     Encrypting it silently breaks search. Needs the same blind-index or a
//     dedicated search index first.
//
// Both are documented rather than half-done: a column that is encrypted but
// whose feature is broken is worse than one that is honestly plaintext.
const { encrypt, decrypt, isEncrypted, isEnabled, redactPhone, redactPII } = require('./crypto');

// Columns wired for encryption. Verified (by grep, this pass) to appear in NO
// WHERE clause on either driver, so encrypting them cannot break a lookup:
//   calls.caller_number        — written by upsert, read for display/CSV only
//   campaign_contacts.phone    — read at dial time, deduped in memory pre-insert
const ENCRYPTED_COLUMNS = ['calls.caller_number', 'campaign_contacts.phone'];

// Encrypt on write. No key → returns the value untouched, so the column
// simply stays plaintext and every read path still works.
function encryptField(value) {
  if (value == null || value === '') return value;
  // Idempotent: re-encrypting an already-encrypted value would produce a
  // double-wrapped string that decrypts to ciphertext, which then silently
  // reaches the UI (or a dialler) as garbage. Cheap guard, real bug class.
  if (isEncrypted(value)) return value;
  return encrypt(String(value));
}

// Decrypt on read. Tolerates plaintext, so rows written before the key was
// set keep working — this is what makes enabling encryption a non-event
// (lazy migration: rows convert as they are next written).
function decryptField(value) {
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch (e) {
    // Wrong/rotated key. Never throw into a request path — a call detail page
    // that renders with a masked phone beats a 500.
    return '***';
  }
}

// Decrypt a set of fields on a row read back from the DB.
function decryptRow(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (out[f] != null) out[f] = decryptField(out[f]);
  }
  return out;
}

const decryptRows = (rows, fields) => (rows || []).map((r) => decryptRow(r, fields));

// Common field sets, so call sites don't restate them.
const CALL_PII_FIELDS = ['caller_number'];
const CONTACT_PII_FIELDS = ['phone'];

module.exports = {
  encryptField, decryptField, decryptRow, decryptRows,
  redactPhone, redactPII, isEncryptionEnabled: isEnabled,
  ENCRYPTED_COLUMNS, CALL_PII_FIELDS, CONTACT_PII_FIELDS,
};
