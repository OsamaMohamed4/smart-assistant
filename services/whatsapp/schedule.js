// When the WhatsApp assistant may answer, and what the company writes for the
// assistant on this channel. Pure functions, no I/O, so they are easy to test.
//
// Everything here is stored inside the company's existing `settings` JSON, so
// no table changes. A company that never fills any of it behaves exactly as it
// did before: no schedule means "always on", no prompt means the scenario's.

const DAY_COUNT = 7;                       // index 0 = Sunday, as Date#getUTCDay
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PROMPT_MAX = 10000;
const KNOWLEDGE_MAX = 20000;

// Saudi Arabia is UTC+3 all year. Same offset the rest of the server uses.
const tzOffsetHours = () => Number(process.env.TZ_OFFSET_HOURS) || 3;

const minutesOf = (hhmm) => {
  const m = HHMM.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function defaultDays() {
  // Saturday to Thursday, 09:00-22:00; Friday off. A starting point to edit.
  return Array.from({ length: DAY_COUNT }, (_, i) => ({ on: i !== 5, from: '09:00', to: '22:00' }));
}

// Reads whatever is stored and returns a complete, safe shape (or null when the
// company has no schedule at all, which means "always on").
function scheduleOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = defaultDays().map((d, i) => {
    const r = Array.isArray(raw.days) ? raw.days[i] : null;
    if (!r || typeof r !== 'object') return d;
    const from = HHMM.test(r.from) ? r.from : d.from;
    const to = HHMM.test(r.to) ? r.to : d.to;
    return { on: r.on === true, from, to };
  });
  return {
    enabled: raw.enabled === true,
    days,
  };
}

// Is the assistant allowed to answer at `now`? A window whose end is earlier
// than its start runs past midnight and belongs to the day it starts on.
function isOpenNow(schedule, now = new Date()) {
  if (!schedule || !schedule.enabled) return true;
  const local = new Date(now.getTime() + tzOffsetHours() * 3600 * 1000);
  const day = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const covers = (d, at, spill) => {
    const w = schedule.days[d];
    if (!w || !w.on) return false;
    const a = minutesOf(w.from);
    const b = minutesOf(w.to);
    if (a === null || b === null || a === b) return false;
    if (a < b) return !spill && at >= a && at < b;             // same-day window
    return spill ? at < b : at >= a;                           // overnight window
  };
  return covers(day, minute, false) || covers((day + DAY_COUNT - 1) % DAY_COUNT, minute, true);
}

// Checks what the screen sent. Returns { settings } to merge into the company's
// settings, or { error } in Arabic for the screen.
function validateControls(body) {
  const b = body || {};
  const out = {};

  if (b.prompt !== undefined) {
    const p = String(b.prompt || '').trim();
    if (p.length > PROMPT_MAX) return { error: `تعليمات واتساب أطول من ${PROMPT_MAX} حرف` };
    out.whatsappPrompt = p;
  }
  if (b.knowledge !== undefined) {
    const k = String(b.knowledge || '').trim();
    if (k.length > KNOWLEDGE_MAX) return { error: `معرفة واتساب أطول من ${KNOWLEDGE_MAX} حرف` };
    out.whatsappKnowledge = k;
  }
  if (b.schedule !== undefined) {
    const s = b.schedule || {};
    if (!Array.isArray(s.days) || s.days.length !== DAY_COUNT) return { error: 'جدول الأيام غير مكتمل' };
    for (const d of s.days) {
      if (d?.on === true && (minutesOf(d.from) === null || minutesOf(d.to) === null)) {
        return { error: 'وقت البدء أو الانتهاء غير صالح (الصيغة 09:00)' };
      }
      if (d?.on === true && d.from === d.to) return { error: 'وقت البدء والانتهاء متطابقان في أحد الأيام' };
    }
    out.whatsappSchedule = scheduleOf(s);
  }
  return { settings: out };
}

module.exports = {
  scheduleOf, isOpenNow, validateControls, defaultDays, minutesOf,
  PROMPT_MAX, KNOWLEDGE_MAX, DAY_COUNT,
};
