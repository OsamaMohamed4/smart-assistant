// Minimal structured logger. Outputs newline-delimited JSON to stdout/stderr
// so log aggregators (Datadog, CloudWatch, journald) can parse without extra
// shipper config. In dev, prints a humanised single line for readability.

const PRETTY = process.env.NODE_ENV !== 'production';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function format(level, msg, fields) {
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
