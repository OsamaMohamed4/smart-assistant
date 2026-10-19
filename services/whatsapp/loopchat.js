// LoopChat — the client's WhatsApp Business provider. Their Developer API
// (https://developer.loopchat.sa/api) is what this speaks, endpoint for
// endpoint as documented:
//
//   GET  /v2/integrations/account-channels    the account's WhatsApp numbers
//   GET  /v2/integrations/templates           approved message templates
//   POST /v2/integrations/messages/send       a free-form message (24-hour window)
//   POST /v2/integrations/templates/send      a template (any time)
//
// Authentication is an Integration Token, generated in LoopChat under
// Settings → Integrations. One token reaches ONE LoopChat account, and each
// company may keep its own account (Wakan and Maheer do): every call here
// takes the token of the account it is meant for, falling back to
// LOOPCHAT_API_TOKEN, the server's own. Tokens never leave the server.
//
// A send can be accepted (HTTP 202) and still not go out: the body then says
// status "failed" with a reason ("The 24-hour window is closed…", "Insufficient
// wallet balance…"). Callers get that reason back rather than an exception,
// because it is an outcome to record, not a bug.
const axios = require('axios');

const BASE = (process.env.LOOPCHAT_API_BASE || 'https://developer.loopchat.sa/api').replace(/\/+$/, '');
const TIMEOUT_MS = 15_000;

const serverToken = () => String(process.env.LOOPCHAT_API_TOKEN || '').trim();
const isConfigured = () => !!serverToken();

function client(token) {
  const t = String(token || '').trim() || serverToken();
  if (!t) throw Object.assign(new Error('لا يوجد مفتاح LoopChat لهذه الشركة ولا على الخادم'), { code: 'NOT_CONFIGURED' });
  return axios.create({
    baseURL: BASE,
    timeout: TIMEOUT_MS,
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  });
}

// The provider's own words for what went wrong, short enough for a log line
// or the settings screen. Validation errors name the field.
function errText(e) {
  const d = e?.response?.data;
  if (d?.errors && typeof d.errors === 'object') {
    const first = Object.values(d.errors).flat()[0];
    if (first) return String(first).slice(0, 300);
  }
  if (d?.message) return String(d.message).slice(0, 300);
  if (e?.response?.status) return `HTTP ${e.response.status}`;
  return String(e?.message || e).slice(0, 300);
}

// LoopChat's lists are paginated at up to 100 per page.
async function listAll(path, key, token) {
  const http = client(token);
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await http.get(path, { params: { per_page: 100, page } });
    const items = r.data?.data?.[key] || [];
    out.push(...items);
    if (!r.data?.meta?.hasMorePages) break;
  }
  return out;
}

async function listChannels(token) {
  return (await listAll('/v2/integrations/account-channels', 'account_channels', token)).map((c) => ({
    id: Number(c.id), name: c.name || '', phoneNumber: c.phone_number || null, hasActiveBot: !!c.has_active_bot,
  }));
}

// Only what the platform needs to pick and fill a template. `variables` is
// the count of {{n}} placeholders in the body, which is what a send must fill.
async function listTemplates(token) {
  return (await listAll('/v2/integrations/templates', 'templates', token)).map((t) => ({
    id: Number(t.id),
    channelId: Number(t.channel_id),
    name: t.template_name || '',
    language: t.language_code || null,
    category: t.template_category || null,
    status: t.status || null,
    headerFormat: t.header_format || null,
    body: t.template_body || '',
    variables: templateVariableCount(t.template_body),
  }));
}

function templateVariableCount(body) {
  const nums = [...String(body || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

// What a send came back with: { ok, status, messageId, reason, contactId }.
// contactId is the LoopChat contact the number was matched to.
function outcome(data) {
  const d = data?.data || {};
  const ok = d.status === 'sent';
  return {
    ok, status: d.status || 'unknown', messageId: d.message_id ?? null,
    reason: ok ? null : (d.failure_reason || 'not sent'), contactId: d.contact_id ?? null,
  };
}

async function sendText({ token, channelId, phone, content }) {
  try {
    const r = await client(token).post('/v2/integrations/messages/send', {
      account_channel_id: Number(channelId),
      phone_number: String(phone).replace(/\D/g, ''),       // documented as digits: 96650…
      type: 'text',
      content: String(content).slice(0, 4096),
    });
    return outcome(r.data);
  } catch (e) {
    return { ok: false, status: 'error', messageId: null, reason: errText(e) };
  }
}

// `variables` is { "1": "…", "2": "…" } — keyed by placeholder number, which
// is how the provider names a missing one ("This template requires variable '2'").
async function sendTemplate({ token, channelId, templateId, phone, variables, header }) {
  try {
    const body = {
      channel_id: Number(channelId),
      template_id: Number(templateId),
      phone: `+${String(phone).replace(/\D/g, '')}`,          // documented with the plus
    };
    if (variables && Object.keys(variables).length) body.variables = variables;
    if (header?.type && header?.url) body.header = { type: header.type, url: header.url };
    const r = await client(token).post('/v2/integrations/templates/send', body);
    return outcome(r.data);
  } catch (e) {
    return { ok: false, status: 'error', messageId: null, reason: errText(e) };
  }
}

module.exports = { isConfigured, listChannels, listTemplates, sendText, sendTemplate, templateVariableCount, errText, BASE };
