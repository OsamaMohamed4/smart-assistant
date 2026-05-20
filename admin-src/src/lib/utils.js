import clsx from 'clsx';
export const cn = (...args) => clsx(...args);

// ─── Date formatting (Arabic-aware) ──────────────────────────
const RTF = new Intl.RelativeTimeFormat('ar-SA', { numeric: 'auto' });
const UNITS = [
  ['year',   31536000],
  ['month',  2592000],
  ['week',   604800],
  ['day',    86400],
  ['hour',   3600],
  ['minute', 60],
  ['second', 1],
];

export function relTime(input) {
  if (!input) return '';
  const date = typeof input === 'string' ? new Date(input + (input.endsWith('Z') ? '' : 'Z')) : new Date(input);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (Number.isNaN(diff)) return '';
  for (const [unit, sec] of UNITS) {
    if (Math.abs(diff) >= sec || unit === 'second') {
      return RTF.format(Math.round(-diff / sec), unit);
    }
  }
  return '';
}

export function fmtDate(input) {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input + (input.endsWith('Z') ? '' : 'Z')) : new Date(input);
  return new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtNumber(n) {
  if (n == null) return '0';
  return new Intl.NumberFormat('ar-SA').format(n);
}

// ─── Avatar gradient from string (consistent hash) ───────────
const GRADIENTS = [
  ['#5b5bd6', '#8b5cf6'],
  ['#0ea5e9', '#5b5bd6'],
  ['#10b981', '#0ea5e9'],
  ['#f59e0b', '#f43f5e'],
  ['#8b5cf6', '#ec4899'],
  ['#06b6d4', '#10b981'],
];
export function gradientFor(seed = '') {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

export function initial(s = '') {
  return (s.trim()[0] || '?').toUpperCase();
}
