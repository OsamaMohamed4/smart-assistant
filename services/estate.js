// Estate (e-statee.com): the real-estate ERP the client's companies run their
// sales in, each on its own address (Maheer's is maher.e-statee.com). A
// request the agent files on a call goes on to the company's Estate as a new
// attention request -- a lead -- through the endpoint Estate documents for
// Make & Zapier (https://api-docs.e-statee.com/new-attention-request-19392637e0):
//
//   POST {company's Estate}/api/v1/make/attention-request/attention-request-store
//   Authorization: Bearer {the company's Estate API key}
//   form-encoded body
//
// What goes, and what does not:
//   - Purchase-interest requests only. That endpoint makes sales leads; Estate
//     keeps rental requests in a module of their own, not linked here.
//   - name, phone (from the call record, never from the model), platform, and
//     note: every answer the customer gave, labelled as on the requests page.
//     `platform` is a value per company, set by a superadmin, because Estate
//     has not said what it should be for a lead from a call.
//   - Estate's docs mark more fields required -- email, ad and campaign names,
//     project, rooms, block, price and size ranges -- that a call does not
//     collect and that are not made up here. The docs are marked "developing";
//     whatever Estate does enforce comes back in its refusal, which is kept on
//     the request and can be checked beforehand with check().
//   - After the call ends: the customer's number is attached from the call
//     record, which exists only then.
//
// Nothing is sent until a superadmin has set the address, the key and the
// platform value and switched it on. Every attempt, and why one did not go,
// is kept on the request (estate_status / estate_detail).
//
// deps.post (and check's `send`) replace the HTTP call in tests; production
// always uses post() below, with its SSRF check.
const axios = require('axios');
const { assertSafeUrl } = require('../lib/ssrf');
const { REQUEST_TYPES, FIELDS } = require('../lib/request-types');

const PATH = '/api/v1/make/attention-request/attention-request-store';
const TIMEOUT_MS = 15_000;
const SENT_TYPES = new Set(['interest']);
const PLATFORM_MAX = 60;

// "https://maher.e-statee.com" from what was pasted -- the bare address or the
// full endpoint. Only an Estate address: customer details go nowhere else.
function estateOrigin(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || !/^[a-z0-9-]+\.e-statee\.com$/i.test(u.hostname)) return null;
  return `https://${u.hostname.toLowerCase()}`;
}

function settingsOf(company) {
  const e = company?.settings?.estate || {};
  return {
    url: estateOrigin(e.url),
    platform: String(e.platform || '').trim().slice(0, PLATFORM_MAX) || null,
    enabled: e.enabled === true,
  };
}

// Estate's own example writes a Saudi mobile the local way: 0551234567.
function estatePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^9665\d{8}$/.test(d)) return `0${d.slice(3)}`;
  if (/^05\d{8}$/.test(d)) return d;
  if (/^5\d{8}$/.test(d)) return `0${d}`;
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

function parseFields(request) {
  try { return request.fields ? JSON.parse(request.fields) || {} : {}; } catch { return {}; }
}

// Every answer the customer gave, one per line, in the client's own labels.
function buildNote(request, fields) {
  const type = REQUEST_TYPES[request.request_type];
  const lines = [`${type?.labelAr || request.request_type} من مكالمة مع المساعد الذكي`];
  for (const k of type?.fields || Object.keys(fields)) {
    if (k === 'customer_name' || !fields[k]) continue;
    lines.push(`${FIELDS[k]?.labelAr || k}: ${fields[k]}`);
  }
  return lines.join('\n');
}

function buildForm({ name, phone, platform, note }) {
  const form = new URLSearchParams();
  form.set('name', name);
  form.set('phone', phone);
  form.set('platform', platform);
  form.set('note', note);
  return form;
}

// Estate's answer in words: its validation errors, or its message.
function estateReason(status, data) {
  if (status === 401 || status === 403) return 'رفض Estate المفتاح';
  if (status === 404) return 'لا توجد واجهة الطلبات هذه على عنوان Estate المحفوظ';
  const errs = data && typeof data.errors === 'object' && data.errors
    ? Object.values(data.errors).flat().filter(Boolean) : [];
  const text = errs.length ? errs.slice(0, 8).join(' — ') : (typeof data?.message === 'string' ? data.message : '');
  return String(text || `HTTP ${status}`).slice(0, 500);
}

// Accepted: a 2xx that does not itself say it failed.
const accepted = (r) => r.status >= 200 && r.status < 300 && r.data?.status !== false;

async function post(origin, token, form) {
  const url = origin + PATH;
  await assertSafeUrl(url);
  return axios.post(url, form.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
  });
}

const unreachable = (e) => (/^blocked url:/.test(e.message)
  ? 'عنوان Estate المحفوظ غير مسموح'
  : `تعذّر الوصول إلى Estate: ${e.code || e.message}`).slice(0, 500);

async function tokenOf(company, deps) {
  const row = await deps.sql.getCompanyEstateToken.get(company.id);
  return deps.decryptField(row?.estate_token) || null;
}

// Ready to send: everything a superadmin sets is set.
async function readiness(company, deps) {
  const cfg = settingsOf(company);
  const token = await tokenOf(company, deps);
  return { ...cfg, token, ready: !!(cfg.enabled && cfg.url && cfg.platform && token) };
}

// One request on to Estate. `retry` takes back one that failed or was
// skipped; a request already sent, or being sent, is never sent again.
async function pushRequest(company, request, deps, { retry = false } = {}) {
  const { sql, logger } = deps;
  const cfg = await readiness(company, deps);
  if (!cfg.ready) return { skipped: 'not configured' };

  const claim = await sql.claimRequestEstate.run({ id: request.id, company_id: company.id, retry: retry ? 1 : 0 });
  if (!claim.changes) return { duplicate: true };
  const finish = (status, detail) => sql.finishRequestEstate.run({ id: request.id, company_id: company.id, status, detail });

  if (!SENT_TYPES.has(request.request_type)) {
    const detail = 'لا يُرسل: واجهة Estate هذه لطلبات البيع، ولطلبات التأجير فيه واجهة أخرى غير مربوطة';
    await finish('skipped', detail);
    return { skipped: detail };
  }
  const fields = parseFields(request);
  const name = String(request.customer_name || fields.customer_name || '').trim();
  if (!name) {
    const detail = 'لا يُرسل: الطلب بلا اسم عميل، وEstate يشترط الاسم';
    await finish('skipped', detail);
    return { skipped: detail };
  }
  const phone = estatePhone(deps.decryptField(request.caller_number));
  if (!phone) {
    const detail = 'لا يُرسل بعد: رقم العميل يُضاف من سجل المكالمة عند انتهائها';
    await finish('skipped', detail);
    return { skipped: detail };
  }

  try {
    const send = deps.post || post;
    const r = await send(cfg.url, cfg.token, buildForm({ name, phone, platform: cfg.platform, note: buildNote(request, fields) }));
    if (accepted(r)) {
      await finish('sent', typeof r.data?.message === 'string' ? r.data.message.slice(0, 300) : null);
      logger.info('estate: request sent', { companyId: company.id, requestId: request.id });
      return { sent: true };
    }
    const reason = estateReason(r.status, r.data);
    await finish('failed', reason);
    logger.warn('estate: request refused', { companyId: company.id, requestId: request.id, status: r.status, reason });
    return { failed: reason };
  } catch (e) {
    const reason = unreachable(e);
    await finish('failed', reason);
    logger.warn('estate: request not sent', { companyId: company.id, requestId: request.id, err: e.message });
    return { failed: reason };
  }
}

// After a call: every request filed during it. Never throws into the call
// pipeline; each outcome is on its request.
async function afterCall(company, call, deps) {
  if (!settingsOf(company).enabled) return [];
  const rows = await deps.sql.listRequestsForEstate.all(company.id, String(call.id));
  const out = [];
  for (const r of rows) out.push(await pushRequest(company, r, deps));
  return out;
}

// Checks the address and the key with a request that carries no fields:
// Estate refuses it (422) and names the fields it enforces -- which is also
// how its real requirements, as opposed to its docs', come to light. Auth is
// checked before validation, so a 422 means the key was accepted.
async function check({ url, token, send = post }) {
  const origin = estateOrigin(url);
  if (!origin) return { ok: false, text: 'عنوان Estate غير صالح. مثال: https://maher.e-statee.com' };
  if (!token) return { ok: false, text: 'لم يُحفظ مفتاح Estate لهذه الشركة بعد.' };
  try {
    const r = await send(origin, token, new URLSearchParams());
    if (r.status === 401 || r.status === 403) return { ok: false, text: 'رفض Estate المفتاح. انسخه من جديد كما أعطاك إياه Estate.' };
    if (r.status === 404) return { ok: false, text: 'لا توجد واجهة الطلبات على هذا العنوان. تأكد من عنوان Estate الخاص بالشركة.' };
    if (r.status === 422) return { ok: true, text: `المفتاح مقبول. يشترط Estate في الطلب: ${estateReason(422, r.data)}` };
    if (accepted(r)) return { ok: true, warn: true, text: 'قبل Estate طلباً بلا بيانات، فربما أنشأ طلباً فارغاً. احذفه من Estate.' };
    return { ok: false, text: `ردّ Estate: ${estateReason(r.status, r.data)}` };
  } catch (e) {
    return { ok: false, text: unreachable(e) };
  }
}

// Settings as a superadmin saves them. Returns { estate } or { error }.
function validateSettings(body, { hasToken }) {
  const b = body || {};
  const rawUrl = String(b.url || '').trim();
  const url = rawUrl ? estateOrigin(rawUrl) : null;
  if (rawUrl && !url) return { error: 'عنوان Estate غير صالح. يجب أن يكون مثل https://maher.e-statee.com' };
  const platform = String(b.platform || '').trim();
  if (platform.length > PLATFORM_MAX) return { error: 'قيمة المصدر (platform) أطول من المسموح' };
  const enabled = b.enabled === true;
  if (enabled && (!url || !platform || !hasToken)) {
    return { error: 'للتشغيل: احفظ عنوان Estate والمفتاح وقيمة المصدر (platform) أولاً' };
  }
  return { estate: { url, platform: platform || null, enabled } };
}

module.exports = {
  afterCall, pushRequest, check, validateSettings, settingsOf, readiness,
  estateOrigin, estatePhone, buildNote, buildForm, estateReason, PATH,
};
