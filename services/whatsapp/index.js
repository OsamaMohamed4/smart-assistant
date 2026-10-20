// WhatsApp for a company, through the client's provider (LoopChat).
//
//   (أ) The assistant answers incoming messages with the company's own scenario
//       and knowledge base — the same text agent the Agent API runs — unless an
//       employee has taken that conversation over in LoopChat.
//   (ب) After a call, a template the company picked goes to the customer's
//       WhatsApp, once per call: when the agent filed a request during it, or
//       after every answered call.
//   (ج) Every message in and out is recorded; that is what the usage page counts.
//
// Configuration lives in the company's settings and only a superadmin sets it
// (one LoopChat channel identifies one company, the same way one phone number
// does):
//   whatsappChannelId   the LoopChat account channel (a WhatsApp number). The
//                       webhook's channel.id is this same id, and the ids run
//                       across LoopChat accounts (Wakan's number is 182 in its
//                       account, Maheer's 184 in another)
//   whatsappAutoReply   answer incoming messages — off until switched on
//   whatsappFollowup    { trigger: 'request' | 'answered', templateId,
//                         variables: [{ source, text }], headerType, headerUrl }
//
// Which LoopChat account a company's number lives in is its token's:
// companies.loopchat_token, or the server's when it has none. A send with another account's token is refused or, worse, goes out
// from that account's number -- so every call here names the company's token.
//
// Nothing here throws at the webhook or the call pipeline: every outcome,
// including "did not send, and why", is a row in whatsapp_messages.
const loopchat = require('./loopchat');
const { connectedCall } = require('../../lib/call-status');
const { REQUEST_TYPES } = require('../../lib/request-types');

// A follow-up belongs to a call that just ended. A provider backfill or a late
// refresh can replay old calls through the same pipeline, and those must not
// message customers about a call from last week.
const FOLLOWUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Where a template variable's value comes from. `text` is the fallback when the
// source is empty, and the whole value for 'fixed'.
const VARIABLE_SOURCES = {
  customer_name: 'اسم العميل',
  company_name : 'اسم الشركة',
  agent_name   : 'اسم المساعد',
  request_type : 'نوع الطلب',
  fixed        : 'نص ثابت',
};
const TRIGGERS = { request: 'عند تسجيل طلب في المكالمة', answered: 'بعد كل مكالمة تم الرد عليها' };

// LoopChat names numbers as international digits (966…).
function waDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15 ? d : null;
}

// The number a template can reach, from a call's customer number. WhatsApp
// lives on mobiles: a Saudi landline (011…, 9661…), a unified or toll-free
// number, or anything malformed is refused with a reason instead of being sent
// and failing at the provider. A foreign number counts only when it was
// written internationally (+ or 00), so a local number is never misread as
// one.
function whatsappNumber(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D/g, '');
  const international = s.startsWith('+') || d.startsWith('00');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) return `966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `966${d}`;
  if (d.startsWith('966')) return /^9665\d{8}$/.test(d) ? d : null;
  return international && d.length >= 10 && d.length <= 15 ? d : null;
}

const channelIdOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function settingsOf(company) {
  const s = company?.settings || {};
  return {
    channelId: channelIdOf(s.whatsappChannelId),
    autoReply: s.whatsappAutoReply === true,
    followup : s.whatsappFollowup && typeof s.whatsappFollowup === 'object' ? s.whatsappFollowup : null,
  };
}

async function companyForChannel(channelId, deps) {
  const id = channelIdOf(channelId);
  if (!id) return null;
  return (await deps.listCompanies()).find((c) => settingsOf(c).channelId === id) || null;
}

// The company's own LoopChat token, or null for the server's. Read here rather
// than passed in, so no caller can forget it.
async function tokenOf(company, deps) {
  const row = await deps.sql.getCompanyLoopchatToken.get(company.id);
  return deps.decryptField(row?.loopchat_token) || null;
}

async function record(deps, row) {
  return deps.sql.insertWhatsappMessage.run({
    channel_id: null, contact_phone: null, body: null, detail: null, event_id: null,
    provider_message_id: null, call_id: null, ...row,
  });
}

// One reply at a time per conversation: two messages sent back to back would
// otherwise be answered in parallel, each without seeing the other.
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

// ─── (أ) incoming messages ─────────────────────────────────────────
async function handleEvent(evt, deps) {
  const type = evt?.event_type;
  if (type === 'message.received') return handleMessage(evt, deps);
  if (type === 'message_integration.stopped' || type === 'message_integration.started') return handleHandover(evt, deps);
  return { ignored: type || 'unknown event' };
}

function describeMedia(msg) {
  const a = Array.isArray(msg?.attachments) ? msg.attachments[0] : msg?.attachments;
  return `[${msg?.type || 'media'}${a?.name ? `: ${a.name}` : ''}]`;
}

async function handleMessage(evt, deps) {
  const { sql, logger } = deps;
  if (evt.message?.traffic && evt.message.traffic !== 'incoming') return { ignored: 'not incoming' };
  const channelId = Number(evt.channel?.id);
  const company = await companyForChannel(channelId, deps);
  if (!company) {
    logger.warn('whatsapp: message on a channel no company uses', { channelId });
    return { ignored: 'unmapped channel' };
  }
  const phone = waDigits(evt.contact?.phone);
  const msg = evt.message?.message || {};
  const isText = msg.type === 'text' && String(msg.text || '').trim();
  const text = isText ? String(msg.text).trim().slice(0, 4000) : '';

  const inserted = await record(deps, {
    company_id: company.id, channel_id: channelId, contact_phone: phone, direction: 'in',
    kind: isText ? 'text' : 'media', body: isText ? text : describeMedia(msg), status: 'received',
    event_id: evt.event_id ? String(evt.event_id).slice(0, 100) : null,
    provider_message_id: evt.message?.messageId != null ? String(evt.message.messageId) : null,
  });
  if (!inserted.changes) return { duplicate: true };

  const cfg = settingsOf(company);
  if (!cfg.autoReply) return { skipped: 'auto-reply off' };
  if (!phone) return { skipped: 'no phone' };
  // Images, voice notes and files are left to the team in LoopChat.
  if (!isText) return { skipped: 'not text' };
  const thread = await sql.getWhatsappThread.get(channelId, phone);
  if (thread && Number(thread.ai_paused)) return { skipped: 'taken over by staff', by: thread.paused_by || null };

  return serialize(`${channelId}:${phone}`, () => reply({ company, channelId, phone, text, contact: evt.contact }, deps));
}

// The reply goes out from the number the customer wrote to -- the company's
// own -- through the company's own LoopChat account.
async function reply({ company, channelId, phone, text, contact }, deps) {
  const { sql, logger } = deps;
  const out = (status, detail, body = null, messageId = null) => record(deps, {
    company_id: company.id, channel_id: channelId, contact_phone: phone, direction: 'out', kind: 'text',
    body, status, detail, provider_message_id: messageId != null ? String(messageId) : null,
  });

  if (!(await deps.checkAndBumpUsage(company.id, 'agent_msgs', deps.dailyCap(company, 'dailyMessageCap', 'DAILY_MSG_CAP', 2000)))) {
    await out('skipped', 'بلغت الشركة الحد اليومي للرسائل');
    return { skipped: 'daily cap' };
  }

  const sessionId = `wa-${phone}`;
  const t0 = Date.now();
  let answer = '';
  try {
    const history = await deps.loadSessionHistory(company.id, sessionId);
    const vars = { customer_phone: `+${phone}` };
    if (contact?.name) vars.customer_name = String(contact.name).slice(0, 80);
    answer = String((await deps.askReply(company, text, history, vars)).reply || '').trim();
  } catch (e) {
    logger.error('whatsapp: reply failed', { err: e.message, companyId: company.id });
    const noScenario = e.code === 'NO_ACTIVE_SCENARIO';
    await out('failed', noScenario ? NO_SCENARIO : 'تعذّر توليد الرد');
    return { failed: noScenario ? 'no scenario' : 'reply' };
  }
  if (!answer) {
    await out('skipped', 'رد فارغ من المساعد');
    return { skipped: 'empty reply' };
  }

  const sent = await loopchat.sendText({ token: await tokenOf(company, deps), channelId, phone, content: answer });
  const reason = sent.ok ? null : refusal(sent, contact);
  await out(sent.ok ? 'sent' : 'failed', reason, answer, sent.messageId);
  if (!sent.ok) logger.warn('whatsapp: reply not sent', { companyId: company.id, reason });
  // The conversation the next turn resumes from, and what the dashboard
  // shows. A reply that never reached the customer is kept out of it, so the
  // assistant does not later assume they read it.
  try {
    await sql.insertChat.run({
      company_id: company.id, session_id: sessionId, user_message: text,
      assistant_reply: sent.ok ? answer : '', channel: 'whatsapp', latency_ms: Date.now() - t0, user_id: null,
    });
  } catch (e) { logger.error('whatsapp: chat insert failed', { err: e.message }); }
  return sent.ok ? { sent: true } : { failed: reason };
}

// LoopChat's reason for not sending. It finds the customer by number: when
// the contact it settled on is not the one who wrote, the number is what went
// wrong, not the window, and the reason says so.
function refusal(sent, contact) {
  let text = String(sent.reason || 'not sent');
  const wrote = contact?.id != null ? String(contact.id) : null;
  const matched = sent.contactId;
  if (wrote && matched != null && String(matched) !== wrote) {
    text += ` (طابق LoopChat الرقم على جهة الاتصال #${matched}، والتي راسلت هي #${wrote})`;
  }
  return String(text).slice(0, 500);
}

// An employee took the conversation over in LoopChat, or handed it back.
async function handleHandover(evt, deps) {
  const channelId = Number(evt.channel?.id);
  const phone = waDigits(evt.contact?.phone);
  const company = await companyForChannel(channelId, deps);
  if (!company || !phone) return { ignored: 'unmapped channel' };
  const paused = evt.event_type === 'message_integration.stopped';
  const by = String((paused ? evt.stopped_by?.name : evt.started_by?.name) || '').slice(0, 80) || null;
  await deps.sql.upsertWhatsappThread.run({
    company_id: company.id, channel_id: channelId, contact_phone: phone,
    ai_paused: paused ? 1 : 0, paused_by: paused ? by : null,
  });
  return { paused, by };
}

// ─── (ب) the template after a call ─────────────────────────────────
async function afterCall(company, call, deps) {
  const { sql, logger } = deps;
  const cfg = settingsOf(company);
  const f = cfg.followup;
  if (!cfg.channelId || !f || !TRIGGERS[f.trigger] || !Number(f.templateId)) return { skipped: 'not configured' };
  const token = await tokenOf(company, deps);
  if (!token && !loopchat.isConfigured()) return { skipped: 'not configured' };
  const at = Date.parse(`${String(call.created_at || call.started_at || '').replace(' ', 'T')}Z`);
  if (!Number.isFinite(at) || Date.now() - at > FOLLOWUP_MAX_AGE_MS) return { skipped: 'call too old' };

  let requests = [];
  if (f.trigger === 'request') {
    requests = await sql.listRequestsForConversation.all(company.id, call.id);
    if (!requests.length) return { skipped: 'no request filed' };
  } else if (!connectedCall(call)) {
    return { skipped: 'not answered' };
  }

  const phone = whatsappNumber(deps.decryptField(call.caller_number));
  // The call is claimed BEFORE sending: (company_id, call_id) is unique, so a
  // second pass over the same call (a webhook retry, a refresh) stops here.
  const claim = await record(deps, {
    company_id: company.id, channel_id: cfg.channelId, contact_phone: phone, direction: 'out', kind: 'template',
    body: `قالب #${f.templateId}`, status: 'pending', call_id: String(call.id),
  });
  if (!claim.changes) return { duplicate: true };
  const id = claim.lastInsertRowid;
  const finish = (status, detail, messageId = null) => sql.updateWhatsappMessage.run({
    id, status, detail, provider_message_id: messageId != null ? String(messageId) : null, body: null,
  });

  if (!phone) {
    await finish('skipped', 'رقم العميل ليس رقم جوال يصله واتساب');
    return { skipped: 'not a mobile' };
  }
  const variables = buildVariables(f.variables, { company, requests, deps });
  const header = f.headerType && f.headerUrl ? { type: f.headerType, url: f.headerUrl } : null;
  const sent = await loopchat.sendTemplate({ token, channelId: cfg.channelId, templateId: f.templateId, phone, variables, header });
  await finish(sent.ok ? 'sent' : 'failed', sent.reason, sent.messageId);
  if (!sent.ok) logger.warn('whatsapp: follow-up not sent', { companyId: company.id, callId: call.id, reason: sent.reason });
  return sent.ok ? { sent: true } : { failed: sent.reason };
}

function buildVariables(list, { company, requests, deps }) {
  const values = {
    customer_name: requests.find((r) => r.customer_name)?.customer_name || '',
    company_name : company.name || '',
    agent_name   : deps.fillGlobals('{{agent_name}}', company),
    request_type : REQUEST_TYPES[requests[0]?.request_type]?.labelAr || '',
  };
  const out = {};
  (Array.isArray(list) ? list : []).forEach((v, i) => {
    const text = String(v?.text || '').trim();
    const value = v?.source === 'fixed' ? text : (values[v?.source] || text);
    out[String(i + 1)] = value.slice(0, 200);
  });
  return out;
}

// ─── What became of a webhook event ────────────────────────────────
// In words for the WhatsApp page, so a message that got no answer shows why:
// the channel is not linked, replies are off, an employee has the
// conversation, LoopChat refused the send, …
const NO_SCENARIO = 'لا يوجد سيناريو مفعّل للشركة';
const SKIPPED = {
  'unmapped channel'   : 'رقم واتساب هذا غير مربوط بأي شركة على المنصة',
  'not incoming'       : 'رسالة صادرة من الرقم نفسه، لا يُرد عليها',
  'auto-reply off'     : 'رد المساعد غير مفعّل لهذه الشركة',
  'no phone'           : 'لم يصل رقم العميل مع الرسالة',
  'not text'           : 'ليست رسالة نصية، فتُترك للفريق',
  'taken over by staff': 'المحادثة عند موظف في LoopChat',
  'daily cap'          : 'بلغت الشركة الحد اليومي للرسائل',
  'empty reply'        : 'رد فارغ من المساعد',
};
function describeOutcome(r) {
  if (!r) return { ok: false, text: 'تعذّرت معالجة الحدث، والتفاصيل في سجل الخادم' };
  if (r.sent) return { ok: true, text: 'ردّ المساعد ووصل الرد إلى LoopChat' };
  if (r.duplicate) return { ok: true, text: 'وصلت من قبل، فلم تُعالج مرة ثانية' };
  // Who, from LoopChat's own event, so a pause nobody remembers making can be
  // traced -- and how it ends, since only LoopChat can end it.
  const by = r.by ? ` (${r.by})` : '';
  if (r.paused === true) return { ok: true, text: `أوقف موظف${by} المساعد في هذه المحادثة من LoopChat، ولا يرد فيها حتى يعيد الموظف تشغيل التكامل لها من LoopChat` };
  if (r.paused === false) return { ok: true, text: `أعاد موظف${by} المحادثة إلى المساعد` };
  if (r.skipped === 'taken over by staff') {
    return { ok: false, text: `المحادثة متوقفة عند موظف${by} في LoopChat، فلم يرد المساعد. لإعادتها: افتح المحادثة في LoopChat وأعد تشغيل التكامل لها` };
  }
  if (r.failed === 'no scenario') return { ok: false, text: NO_SCENARIO };
  if (r.failed) return { ok: false, text: r.failed === 'reply' ? 'تعذّر توليد الرد' : `لم يُرسل الرد، وسبب LoopChat: ${r.failed}` };
  const why = r.skipped || r.ignored;
  if (why === 'unmapped channel') return { ok: false, unmapped: true, text: SKIPPED[why] };
  if (SKIPPED[why]) return { ok: false, text: SKIPPED[why] };
  if (why === 'unknown event') return { ok: false, text: 'وصل طلب بلا نوع حدث، وبياناته على غير الشكل الموثّق' };
  return { ok: false, text: `حدث لا يخص المساعد: ${why}` };
}

// ─── Settings, validated ───────────────────────────────────────────
// Returns { settings } to merge into the company's settings, or { error }.
function validateSettings(body) {
  const b = body || {};
  const channelId = b.channelId === null || b.channelId === '' || b.channelId === undefined ? null : Number(b.channelId);
  if (channelId !== null && (!Number.isInteger(channelId) || channelId <= 0)) return { error: 'رقم قناة واتساب غير صالح' };
  const f = b.followup || {};
  const trigger = f.trigger || 'off';
  if (trigger !== 'off' && !TRIGGERS[trigger]) return { error: 'توقيت رسالة المتابعة غير معروف' };
  let followup = null;
  if (trigger !== 'off') {
    const templateId = Number(f.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) return { error: 'اختر قالب رسالة المتابعة' };
    if (!channelId) return { error: 'رسالة المتابعة تحتاج قناة واتساب' };
    const variables = (Array.isArray(f.variables) ? f.variables : []).slice(0, 10).map((v) => ({
      source: VARIABLE_SOURCES[v?.source] ? v.source : 'fixed',
      text  : String(v?.text || '').trim().slice(0, 200),
    }));
    const headerUrl = String(f.headerUrl || '').trim();
    const headerType = ['image', 'video', 'document'].includes(f.headerType) ? f.headerType : null;
    if (headerUrl && !/^https:\/\/\S{4,2000}$/.test(headerUrl)) return { error: 'رابط صورة القالب يجب أن يبدأ بـ https://' };
    followup = { trigger, templateId, variables, headerType: headerUrl ? headerType : null, headerUrl: headerUrl || null };
  }
  return {
    settings: {
      whatsappChannelId: channelId,
      whatsappAutoReply: b.autoReply === true && !!channelId,
      whatsappFollowup : followup,
    },
  };
}

module.exports = {
  handleEvent, afterCall, validateSettings, settingsOf, companyForChannel, describeOutcome,
  whatsappNumber, waDigits, buildVariables,
  VARIABLE_SOURCES, TRIGGERS, FOLLOWUP_MAX_AGE_MS,
};
