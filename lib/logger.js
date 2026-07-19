// Minimal structured logger. Outputs newline-delimited JSON to stdout/stderr
// so log aggregators (Datadog, CloudWatch, journald) can parse without extra
// shipper config. In dev, prints a humanised single line for readability.

const PRETTY = process.env.NODE_ENV !== 'production';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

// PDPL: mask phone numbers before they reach a log line (audit F-04b).
// Logs are shipped off-platform, retained on someone else's schedule, and read
// by people who have no reason to see a customer's number. Applied to values
// under PII-ish keys AND to the message itself, since numbers routinely arrive
// embedded in error strings ("call to +9665... failed").
//
// Deliberately not gated behind an env var: there is no scenario where a full
// phone number in a log is the desired outcome, and a flag would just be a way
// to get it wrong. LOG_REDACT_PII=0 exists only as a debugging escape hatch.
const REDACT = process.env.LOG_REDACT_PII !== '0';
const PII_KEY_RE = /phone|caller|mobile|email|transcript|customer/i;

function redactValue(v) {
  return String(v == null ? '' : v).replace(/\+?\d[\d\s-]{5,}\d/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 6 ? `${d.slice(0, 3)}***${d.slice(-2)}` : '***';
  });
}

function scrub(fields, msg) {
  if (!REDACT) return { fields, msg };
  const safeMsg = typeof msg === 'string' ? redactValue(msg) : msg;
  if (!fields) return { fields, msg: safeMsg };
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = (typeof v === 'string' && (PII_KEY_RE.test(k) || /\d[\d\s-]{5,}\d/.test(v)))
      ? redactValue(v)
      : v;
  }
  return { fields: out, msg: safeMsg };
}

function format(level, rawMsg, rawFields) {
  const { fields, msg } = scrub(rawFields, rawMsg);
  const base = { ts: new Date().toISOString(), level, msg };
  const merged = fields ? { ...base, ...fields } : base;
  if (!PRETTY) return JSON.stringify(merged);
  // Pretty single-line for dev terminals.
  const tail = fields
    ? ' ' + Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
    : '';
  return `${base.ts} ${level.padEnd(5)} ${msg}${tail}`;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = format(level, msg, fields);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

// Returns a child logger that auto-injects fields (e.g. requestId) into each line.
function child(boundFields) {
  return {
    debug: (msg, f) => emit('debug', msg, { ...boundFields, ...f }),
    info : (msg, f) => emit('info',  msg, { ...boundFields, ...f }),
    warn : (msg, f) => emit('warn',  msg, { ...boundFields, ...f }),
    error: (msg, f) => emit('error', msg, { ...boundFields, ...f }),
    child: (extra) => child({ ...boundFields, ...extra }),
  };
}

const logger = child({});

module.exports = { logger };
