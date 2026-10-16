// What became of a call — and the one place a SIP status code is read, so the
// call list, the campaign report and the campaign retry agree on what a 480
// or a 403 means.
//
// A call that never connected missed the customer for one of two reasons. The
// CUSTOMER's side: nobody picked up, the line was busy, the call was declined,
// the phone was off, the number does not exist. Or OUR side: the trunk or the
// PBX refused the call, its credentials were wrong, something was down.
// Outbound calls used to show the first kind as "فاشلة" — which reads to a
// company as the platform failing, when the customer simply did not answer.
// They now say «لم يتم الرد»; «تعذّر الاتصال» is kept for the line's own
// faults, which only an operator can fix and must be able to see.

// Calls with no outcome yet are "in progress" for this long, then they are
// read as never having connected.
const IN_PROGRESS_MS = 60 * 60 * 1000;

const SIP_NO_ANSWER = new Set([408, 480, 487]);       // timed out, unavailable, cancelled while ringing
const SIP_BUSY = new Set([486, 600, 603]);            // busy here, busy everywhere, declined
const SIP_INVALID = new Set([404, 410, 484, 604]);    // not found, gone, incomplete, nowhere

function sipCode(reason) {
  const m = /(?:^|[^a-z0-9])sip-(\d{3})(?!\d)/i.exec(String(reason || ''));
  return m ? Number(m[1]) : null;
}

// 'no_answer' | 'busy' | 'invalid' | 'failed', or null when the reason is not
// a SIP status at all.
function sipDisposition(reason) {
  const code = sipCode(reason);
  if (code === null) return null;
  if (SIP_NO_ANSWER.has(code)) return 'no_answer';
  if (SIP_BUSY.has(code)) return 'busy';
  if (SIP_INVALID.has(code)) return 'invalid';
  return 'failed';
}

// Reasons on the customer's side, in the provider-neutral vocabulary
// services/voice/elevenlabs.js maps onto.
const CUSTOMER_SIDE_RE = /no-?answer|did-not-?answer|voicemail|machine|busy|switched-?off|powered-?off|unreachable|invalid|not-?in-?service|unallocated|does-?not-?exist|rejected|declined/i;
const OUR_SIDE_RE = /pipeline-error|provider-?fault|proxy-authentication|failed-to-connect|twilio-failed/i;

function connectedCall(row) {
  return Number(row?.duration_sec || 0) > 0 || !!row?.has_transcript || !!row?.transcript;
}

// 'completed' | 'in_progress' | 'no_answer' | 'failed'
function callStatus(row, now = Date.now()) {
  const reason = String(row?.ended_reason || '');
  if (connectedCall(row)) return 'completed';
  if (!reason) {
    const ts = Date.parse(`${String(row?.created_at || '').replace(' ', 'T')}Z`);
    if (Number.isFinite(ts) && now - ts < IN_PROGRESS_MS) return 'in_progress';
    // Never heard back. On a call we placed, the customer not answering is
    // the ordinary reason; an inbound call that left no trace is a fault.
    return row?.direction === 'outbound' ? 'no_answer' : 'failed';
  }
  const sip = sipDisposition(reason);
  if (sip) return sip === 'failed' ? 'failed' : 'no_answer';
  if (OUR_SIDE_RE.test(reason)) return 'failed';
  if (CUSTOMER_SIDE_RE.test(reason)) return 'no_answer';
  return row?.direction === 'outbound' ? 'no_answer' : 'failed';
}

// The reason a call ended, said in Arabic. null when there is nothing useful
// to add (no reason recorded, or one this vocabulary does not know).
const SIP_LABELS = {
  480: 'الجوال غير متاح أو لم يُرد عليه',
  408: 'لم يرد العميل',
  487: 'لم يرد العميل',
  486: 'الخط مشغول',
  600: 'الخط مشغول',
  603: 'رفض العميل المكالمة',
  404: 'الرقم غير صحيح أو غير موجود',
  410: 'الرقم غير صحيح أو غير موجود',
  484: 'الرقم غير مكتمل',
  604: 'الرقم غير صحيح أو غير موجود',
  401: 'خط الاتصال رفض بيانات الدخول',
  407: 'خط الاتصال رفض بيانات الدخول',
  403: 'خط الاتصال رفض المكالمة',
};
const REASON_LABELS = [
  [/^assistant-ended-call$/, 'أنهى المساعد المكالمة'],
  [/^customer-ended-call$/, 'أنهى العميل المكالمة'],
  [/forward|transfer/, 'حُوّلت إلى موظف'],
  [/silence-timed-out/, 'انتهت بعد صمت طويل'],
  [/max-duration/, 'بلغت المدة القصوى للمكالمة'],
  [/voicemail|machine/, 'ردّ البريد الصوتي'],
  [/no-?answer|did-not-?answer/, 'لم يرد العميل'],
  [/busy/, 'الخط مشغول'],
  [/switched-?off|powered-?off|unreachable/, 'الجوال مغلق أو خارج التغطية'],
  [/invalid|not-?in-?service|unallocated|does-?not-?exist/, 'الرقم غير صحيح'],
  [/rejected|declined/, 'رُفضت المكالمة'],
  [OUR_SIDE_RE, 'خطأ تقني في خط الاتصال'],
];

function endedReasonLabel(reason) {
  const r = String(reason || '').toLowerCase();
  if (!r) return null;
  const code = sipCode(r);
  if (code !== null) {
    if (SIP_LABELS[code]) return SIP_LABELS[code];
    return code >= 500 ? 'عطل في خط الاتصال' : 'خط الاتصال رفض المكالمة';
  }
  for (const [re, label] of REASON_LABELS) if (re.test(r)) return label;
  return null;
}

module.exports = { callStatus, endedReasonLabel, sipDisposition, sipCode, connectedCall, IN_PROGRESS_MS };
