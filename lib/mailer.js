// Outgoing email, from the platform's own mailbox (info@getmasar.sa on
// Microsoft 365).
//
// Two ways out, picked by what is configured:
//   1. Microsoft Graph (MS_TENANT_ID + MS_CLIENT_ID + MS_CLIENT_SECRET): an
//      Entra app with the Mail.Send application permission sends as
//      SMTP_USER. This is the route Microsoft keeps open: Exchange Online has
//      been retiring Basic authentication for SMTP AUTH, so a mailbox
//      password may be refused even with SMTP switched on for the mailbox.
//   2. SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS): STARTTLS on 587.
//
// sendMail never throws: it answers { ok, transport, id?, error? } so a
// caller records what happened instead of crashing a scheduled run.
const axios = require('axios');

const FROM_NAME = 'مسار';

const env = (k) => String(process.env[k] || '').trim();
const sender = () => env('MAIL_FROM') || env('SMTP_USER');

function transportName() {
  if (env('MS_TENANT_ID') && env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET') && sender()) return 'graph';
  if (env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS')) return 'smtp';
  return null;
}
const isConfigured = () => !!transportName();

// What a person can act on, in Arabic. Microsoft's codes are kept in the text
// so whoever fixes it can look them up.
function explain(e) {
  const raw = String(e?.response || e?.message || e || '');
  if (/5\.7\.139|basic authentication is disabled/i.test(raw)) {
    return 'رفضت Microsoft الدخول بكلمة المرور (المصادقة الأساسية لـ SMTP متوقفة في Microsoft 365). المطلوب تطبيق في Entra بصلاحية Mail.Send وإضافة MS_TENANT_ID وMS_CLIENT_ID وMS_CLIENT_SECRET في Railway. (5.7.139)';
  }
  if (/5\.7\.3|535|authentication unsuccessful|invalid login/i.test(raw)) {
    return 'رُفض اسم المستخدم أو كلمة المرور لصندوق البريد. تحقق من SMTP_USER وSMTP_PASS، ومن تفعيل «Authenticated SMTP» لهذا الصندوق في Microsoft 365. (535)';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET/i.test(raw)) return `تعذّر الاتصال بخادم البريد (${raw.slice(0, 120)})`;
  return raw.slice(0, 300) || 'تعذّر الإرسال';
}

let smtpTransport = null;
function smtp() {
  if (!smtpTransport) {
    const nodemailer = require('nodemailer');
    const port = Number(env('SMTP_PORT')) || 587;
    smtpTransport = nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return smtpTransport;
}

// Client-credentials token for Graph, reused until shortly before it expires.
let graphToken = null;
async function graphAccessToken() {
  if (graphToken && graphToken.expires > Date.now() + 60_000) return graphToken.value;
  const base = env('MS_LOGIN_BASE') || 'https://login.microsoftonline.com';
  const r = await axios.post(`${base}/${encodeURIComponent(env('MS_TENANT_ID'))}/oauth2/v2.0/token`, new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env('MS_CLIENT_ID'),
    client_secret: env('MS_CLIENT_SECRET'),
    scope: 'https://graph.microsoft.com/.default',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 });
  graphToken = { value: r.data.access_token, expires: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 };
  return graphToken.value;
}

async function sendViaGraph({ to, cc, subject, html, text }) {
  const base = env('MS_GRAPH_BASE') || 'https://graph.microsoft.com';
  const token = await graphAccessToken();
  const addr = (list) => list.map((address) => ({ emailAddress: { address } }));
  await axios.post(`${base}/v1.0/users/${encodeURIComponent(sender())}/sendMail`, {
    message: {
      subject,
      body: { contentType: html ? 'HTML' : 'Text', content: html || text || '' },
      toRecipients: addr(to),
      ...(cc?.length ? { ccRecipients: addr(cc) } : {}),
    },
    saveToSentItems: true,
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20_000 });
  return null;     // Graph answers 202 with no message id
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;
const cleanList = (v) => [...new Set((Array.isArray(v) ? v : [v]).map((x) => String(x || '').trim().toLowerCase()).filter((x) => EMAIL_RE.test(x)))];

async function sendMail({ to, cc, subject, html, text }) {
  const transport = transportName();
  if (!transport) return { ok: false, transport: null, error: 'البريد غير مضبوط على الخادم (SMTP_HOST وSMTP_USER وSMTP_PASS).' };
  const recipients = cleanList(to);
  if (!recipients.length) return { ok: false, transport, error: 'لا يوجد بريد مستلم صالح' };
  const copies = cleanList(cc || []);
  try {
    if (transport === 'graph') {
      await sendViaGraph({ to: recipients, cc: copies, subject, html, text });
      return { ok: true, transport, id: null };
    }
    const info = await smtp().sendMail({
      from: { name: FROM_NAME, address: sender() },
      to: recipients,
      ...(copies.length ? { cc: copies } : {}),
      subject, html, text,
    });
    return { ok: true, transport, id: info?.messageId || null };
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e?.response?.data?.error_description;
    return { ok: false, transport, error: explain(detail || e) };
  }
}

// Tests swap the SMTP transport (nodemailer's jsonTransport) and reset caches.
function _setSmtpTransport(t) { smtpTransport = t; }
function _reset() { smtpTransport = null; graphToken = null; }

module.exports = { sendMail, isConfigured, transportName, sender, explain, cleanList, _setSmtpTransport, _reset };
