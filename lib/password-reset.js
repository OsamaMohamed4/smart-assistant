// Password-reset and sign-in links by e-mail.
//
// A link carries a random 256-bit token; the database keeps only its SHA-256,
// so reading the table gives nobody a way in. A token works ONCE and only
// for a while: an hour when the user asked ("نسيت كلمة المرور"), three days
// when an operator sends someone their sign-in link. Issuing a new link
// retires every earlier one, so only the newest e-mail works.
const crypto = require('crypto');
const { sql } = require('../db');

const TTL_MS = { reset: 60 * 60 * 1000, invite: 72 * 60 * 60 * 1000 };
// At most this many reset e-mails per account per hour, however often the
// form is submitted — so the form cannot be used to flood someone's inbox.
const MAX_PER_HOUR = 3;

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw || '')).digest('hex');
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const fromStamp = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);

async function issueToken(userId, purpose = 'reset', ip = null) {
  if (!TTL_MS[purpose]) throw new Error(`unknown purpose ${purpose}`);
  const raw = crypto.randomBytes(32).toString('base64url');
  await sql.retireUserResets.run(userId);
  await sql.insertPasswordReset.run({
    user_id: userId, token_hash: hashToken(raw), purpose,
    expires_at: stamp(Date.now() + TTL_MS[purpose]), created_ip: ip ? String(ip).slice(0, 64) : null,
  });
  return raw;
}

// The token's row while it can still be used; null otherwise.
async function findValid(raw) {
  if (!raw || String(raw).length < 20 || String(raw).length > 200) return null;
  const row = await sql.getPasswordReset.get(hashToken(raw));
  if (!row || row.used_at) return null;
  if (!(fromStamp(row.expires_at) > Date.now())) return null;
  return row;
}

// Claim the token for good. Two submissions racing for one link: exactly one wins.
async function consumeToken(raw) {
  const row = await findValid(raw);
  if (!row) return { error: 'الرابط غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً.' };
  const r = await sql.usePasswordReset.run(row.id);
  if (!r.changes) return { error: 'استُخدم هذا الرابط من قبل. اطلب رابطاً جديداً.' };
  return { row };
}

async function tooManyRecent(userId) {
  const since = stamp(Date.now() - 60 * 60 * 1000);
  return ((await sql.countRecentResets.get(userId, since))?.n || 0) >= MAX_PER_HOUR;
}

// "o***r@maheer.sa" — enough for someone to recognise their own address.
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 2))}${local.length > 1 ? local.slice(-1) : ''}@${domain}`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** The e-mail for a link. purpose 'reset' or 'invite'. */
function linkEmail({ link, name, purpose = 'reset', companyName = null }) {
  const invite = purpose === 'invite';
  const hello = name ? `مرحباً ${name}،` : 'مرحباً،';
  const lines = invite
    ? [
      `تم تجهيز حسابك في لوحة تحكم مسار${companyName ? ` لـ ${companyName}` : ''}.`,
      'اضغط الزر لتعيين كلمة المرور والدخول. الرابط صالح لمدة 72 ساعة ولمرة واحدة.',
    ]
    : [
      'وصلنا طلب لإعادة تعيين كلمة المرور لحسابك في لوحة تحكم مسار.',
      'اضغط الزر لتعيين كلمة مرور جديدة. الرابط صالح لمدة ساعة ولمرة واحدة.',
      'إذا لم تطلب ذلك فتجاهل هذه الرسالة، وستبقى كلمة المرور الحالية كما هي.',
    ];
  const button = invite ? 'تعيين كلمة المرور' : 'إعادة تعيين كلمة المرور';
  const subject = invite ? 'رابط الدخول إلى لوحة تحكم مسار' : 'إعادة تعيين كلمة المرور — مسار';
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#FAF8F5;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #E6E0D6;border-radius:8px;">
  <tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:700;color:#8439FF;">مسار</td></tr>
  <tr><td style="padding:8px 28px;font-size:15px;color:#1A150E;line-height:1.9;">
    <div>${esc(hello)}</div>
    ${lines.map((l) => `<div>${esc(l)}</div>`).join('')}
  </td></tr>
  <tr><td style="padding:16px 28px;">
    <a href="${esc(link)}" style="display:inline-block;background:#8439FF;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;">${esc(button)}</a>
  </td></tr>
  <tr><td style="padding:8px 28px 28px;font-size:12px;color:#7A7166;line-height:1.8;">
    إذا لم يعمل الزر، انسخ هذا الرابط في المتصفح:<br><span dir="ltr" style="word-break:break-all;">${esc(link)}</span>
  </td></tr>
</table></td></tr></table></body></html>`;
  const text = [hello, ...lines, '', `${button}: ${link}`].join('\n');
  return { subject, html, text };
}

module.exports = { issueToken, findValid, consumeToken, tooManyRecent, maskEmail, linkEmail, hashToken, TTL_MS, MAX_PER_HOUR };
