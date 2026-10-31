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
// What Estate asked for, in its reply of 2026-10-21 (relayed by the client):
// the customer's name, phone, the project they are interested in, and their
// notes; rooms, district, budget and the like when the call has them; no
// email and no campaign data. `platform` is `ai_chat`. The project goes as
// its short code in project_codes[0] (M-10 for Maheer, W-38 for Wakan), not
// as an id. Both companies' projects live on one Estate, Maheer's address,
// with one key -- told apart by the project code.
//
// What goes, and what does not:
//   - Purchase-interest requests only. That endpoint makes sales leads; Estate
//     keeps rental requests in a module of their own, not linked here.
//   - name, phone (from the call record, never from the model), platform,
//     project_codes[0] when the customer named a project on the company's
//     list, and note: every answer the customer gave, labelled as on the
//     requests page. The call collects no rooms, district or budget, so none
//     is sent; whatever the customer said goes in the note.
//   - The project list -- name as the agent offers it, Estate's code -- is set
//     per company by a superadmin. The model picks from those names (the
//     request tool's enum, rebuilt on «نشر»), so a name maps to its code
//     exactly; nothing is guessed from free text.
//   - After the call ends: the customer's number is attached from the call
//     record, which exists only then. A request made on WhatsApp carries the
//     WhatsApp number instead, and goes as soon as the customer confirms it
//     (services/whatsapp/requests.js).
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
// Estate's value for a lead from the assistant (its reply of 2026-10-21).
const PLATFORM_DEFAULT = 'ai_chat';
const PROJECTS_MAX = 200;
const PROJECT_NAME_MAX = 120;
// Estate's format (its note of 2026-10-31): the company's letter, a hyphen,
// the project's number -- W-38 is Wakan's project 38, M-12 Maheer's 12.
const PROJECT_CODE = /^[A-Z]{1,4}-\d{1,6}$/;

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
    platform: String(e.platform || '').trim().slice(0, PLATFORM_MAX) || PLATFORM_DEFAULT,
    enabled: e.enabled === true,
    projects: Array.isArray(e.projects) ? e.projects.filter((p) => p?.name && p?.code) : [],
  };
}

// The project list as pasted: one per line, "name = code" (the code after the
// last "="). Returns { projects } or { error } naming the line.
function parseProjects(input) {
  if (Array.isArray(input)) input = input.map((p) => `${p?.name || ''} = ${p?.code || ''}`).join('\n');
  const projects = [];
  const seen = new Set();
  const lines = String(input || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = line.lastIndexOf('=');
    const name = (at > 0 ? line.slice(0, at) : '').trim().replace(/\s+/g, ' ');
    const raw = (at > 0 ? line.slice(at + 1) : '').trim();
    const code = cleanCode(raw);
    if (!name || !raw) return { error: `السطر ${i + 1}: اكتبه «اسم المشروع = رمزه في Estate»` };
    if (name.length > PROJECT_NAME_MAX) return { error: `السطر ${i + 1}: اسم المشروع أطول من المسموح` };
    if (!PROJECT_CODE.test(code)) return { error: `السطر ${i + 1}: رمز المشروع «${raw.slice(0, 30)}» ليس بصيغة Estate: حرف الشركة ثم شرطة ثم رقم المشروع، مثل W-38 أو M-12` };
    const key = normalizeName(name);
    if (seen.has(key)) return { error: `السطر ${i + 1}: المشروع «${name}» مكرر` };
    seen.add(key);
    projects.push({ name, code });
  }
  if (projects.length > PROJECTS_MAX) return { error: `الحد الأعلى ${PROJECTS_MAX} مشروعاً` };
  return { projects };
}

// For matching what the model sent against the list: the enum makes it the
// same text, but spacing, diacritics and the kashida are not worth a miss.
function normalizeName(s) {
  return String(s || '').normalize('NFKC').replace(/[ً-ٰٟـ]/g, '')
    .replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

// A code as typed, in Estate's form: "w-38", "W–38" (another dash) and
// "W-٣٨" are all W-38. Nothing else is changed: "W38" stays wrong, to be
// written again, rather than guessed at.
function cleanCode(raw) {
  return String(raw || '').trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0))
    .replace(/\s*[‐-―−]\s*|\s*-\s*/g, '-')
    .toUpperCase();
}

// The Estate code for the project the customer named, or null. Sent as
// Estate writes it, whatever a list saved before the format was enforced holds.
function projectCode(value, projects) {
  const v = normalizeName(value);
  if (!v) return null;
  const hit = (projects || []).find((p) => normalizeName(p.name) === v || normalizeName(p.code) === v);
  return hit ? cleanCode(hit.code) : null;
}

// Digits with the country code, no "+" and no local 0: 966501234567,
// 966115009384. Estate asked for exactly this (2026-10-24), after a lead went
// as "+0115009384"; its docs' example (0551234567) is not what it wants.
function estatePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^966[1-9]\d{8}$/.test(d)) return d;
  if (/^0[1-9]\d{8}$/.test(d)) return `966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `966${d}`;
  // A local number of any other length is not one this can place.
  if (d.startsWith('0')) return null;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function parseFields(request) {
  try { return request.fields ? JSON.parse(request.fields) || {} : {}; } catch { return {}; }
}

// Where the request was made, in words.
function sourceOf(request) {
  if (request.channel === 'whatsapp') return 'محادثة واتساب';
  if (request.call_direction === 'inbound') return 'مكالمة واردة';
  if (request.call_direction === 'outbound') return 'مكالمة صادرة';
  return 'مكالمة';
}

// The assistant the customer spoke to, as the note names it: its name and its
// company's. Both companies' leads land on one Estate, and Estate asked
// (2026-10-31) for the agent in the note to tell them apart.
function agentLabel(company) {
  if (!company) return null;
  const { fillGlobals } = require('../companies');
  const name = String(fillGlobals('{{agent_name}}', company) || '').trim();
  return [name, company.name].filter(Boolean).join(' — ') || null;
}

// Every answer the customer gave, one per line, in the client's own labels,
// under where it was made -- an inbound or outbound call, or a WhatsApp
// conversation -- and with which assistant.
function buildNote(request, fields, company = null) {
  const type = REQUEST_TYPES[request.request_type];
  const agent = agentLabel(company);
  const head = `${type?.labelAr || request.request_type} من ${sourceOf(request)}`;
  const lines = agent ? [head, `المساعد الذكي: ${agent}`] : [`${head} مع المساعد الذكي`];
  for (const k of type?.fields || Object.keys(fields)) {
    if (k === 'customer_name' || !fields[k]) continue;
    lines.push(`${FIELDS[k]?.labelAr || k}: ${fields[k]}`);
  }
  return lines.join('\n');
}

function buildForm({ name, phone, platform, projectCode: code, note }) {
  const form = new URLSearchParams();
  form.set('name', name);
  form.set('phone', phone);
  form.set('platform', platform);
  if (code) form.set('project_codes[0]', code);
  form.set('note', note);
  return form;
}

// Estate's answer in words: its validation errors, or its message.
function estateReason(status, data) {
  if (status === 401 || status === 403) {
    return `رفض Estate المفتاح${typeof data?.message === 'string' && data.message ? ` (${data.message.slice(0, 200)})` : ''}`;
  }
  if (status === 404) return 'لا توجد واجهة الطلبات هذه على عنوان Estate المحفوظ';
  const errs = data && typeof data.errors === 'object' && data.errors
    ? Object.values(data.errors).flat().filter(Boolean) : [];
  const text = errs.length ? errs.slice(0, 8).join(' — ') : (typeof data?.message === 'string' ? data.message : '');
  return String(text || `HTTP ${status}`).slice(0, 500);
}

// Accepted: a 2xx that does not itself say it failed.
const accepted = (r) => r.status >= 200 && r.status < 300 && r.data?.status !== false;

// The key as Estate issued it. Copied out of an Arabic chat or e-mail, a key
// picks up what does not show: direction marks (U+200E/F, U+202A-E,
// U+2066-9), zero-width characters, a BOM, non-breaking spaces, a line break,
// quotes around it -- and sometimes the word "Bearer". Any of them makes
// Estate answer "header api-key is missing or not correct". A key has none.
const HIDDEN = /[​-‏‪-‮⁠-⁩﻿ ]/g;
function cleanKey(token) {
  const QUOTES = /^["'`«»\s]+|["'`«»\s]+$/g;
  return String(token || '').replace(HIDDEN, '').replace(QUOTES, '')
    .replace(/^bearer\s+/i, '')
    .replace(/\s+/g, '')
    .replace(QUOTES, '');
}
const bareKey = cleanKey;

// Enough of the saved key to compare with what Estate sent, and no more.
function keyHint(token) {
  const k = cleanKey(token);
  if (!k) return null;
  const head = Math.min(3, Math.floor(k.length / 4));
  const tail = Math.min(2, Math.floor(k.length / 6));       // slice(-0) would be all of it
  return {
    length: k.length,
    start: k.slice(0, head),
    end: tail ? k.slice(-tail) : '',
    cleaned: k !== String(token || ''),
  };
}

// Estate's docs say Bearer, but its server reads the key from an `api-key`
// header: with Bearer alone it answers 403 "header api-key is missing or not
// correct" (seen live on maher.e-statee.com, 2026-10-22). Both are sent.
function estateHeaders(token) {
  const key = bareKey(token);
  return {
    'api-key': key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function post(origin, token, form) {
  const url = origin + PATH;
  await assertSafeUrl(url);
  return axios.post(url, form.toString(), {
    headers: estateHeaders(token),
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
    const r = await send(cfg.url, cfg.token, buildForm({
      name, phone, platform: cfg.platform,
      projectCode: projectCode(fields.project, cfg.projects),
      note: buildNote(request, fields, company),
    }));
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
    if (r.status === 401 || r.status === 403) return { ok: false, text: `${estateReason(r.status, r.data)}. تأكد أنه المفتاح الذي أعطاك إياه Estate، منسوخاً كاملاً.` };
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
  const p = parseProjects(b.projects);
  if (p.error) return { error: p.error };
  const enabled = b.enabled === true;
  if (enabled && (!url || !hasToken)) {
    return { error: 'للتشغيل: احفظ عنوان Estate والمفتاح أولاً' };
  }
  return { estate: { url, platform: platform || null, enabled, projects: p.projects } };
}

module.exports = {
  afterCall, pushRequest, check, validateSettings, settingsOf, readiness,
  estateOrigin, estatePhone, buildNote, buildForm, estateReason, estateHeaders, cleanKey, keyHint, parseProjects, projectCode,
  PATH, PLATFORM_DEFAULT,
};
