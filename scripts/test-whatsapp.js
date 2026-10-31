// WhatsApp through LoopChat: the assistant answers incoming messages, an
// employee can take a conversation over, a template follows a call once, and
// every message is counted.
//
// Real statements on a throwaway SQLite DB; LoopChat is a local fake that
// records what it was sent; the model is a stub. No network.
//
//   node --test scripts/test-whatsapp.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const DB = path.join(require('node:os').tmpdir(), `sa-whatsapp-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;
process.env.LOOPCHAT_API_TOKEN = 'lc-test-token';

// ─── Fake LoopChat ────────────────────────────────────────────────
const sent = [];
let sendResult = 'sent';
let beforeAnswer = null;
let matchedContact = 101;
// LoopChat's per-conversation integration switch, by phone; absent = no contact.
const integrationSwitch = new Map();
// Two LoopChat accounts, as the client has them: one token each, and a token
// reaches only its own account's numbers -- a send naming another account's
// number is refused (422). The server's token is the first.
const ACCOUNTS = {
  'lc-test-token' : { channels: [{ id: 6, name: 'WhatsApp 1', phone_number: '+966920031118' }] },
  'lc-wakan-token': { channels: [{ id: 182, name: 'WhatsApp 1', phone_number: '+966920022808' }] },
};
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const account = ACCOUNTS[token];
    if (!account) return json(401, { message: 'Unauthenticated.' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/v2/integrations/account-channels') {
      return json(200, { data: { account_channels: account.channels.map((c) => ({ ...c, has_active_bot: false, created_at: 'x' })) }, meta: { hasMorePages: false } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/integrations/contacts') {
      const phone = url.searchParams.get('filter[phone_number]');
      const contacts = integrationSwitch.has(phone)
        ? [{ id: 101, name: 'أبو فهد', phone_number: phone, message_integration: integrationSwitch.get(phone), created_at: 'x' }] : [];
      return json(200, { data: { contacts }, meta: { hasMorePages: false } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/integrations/templates') {
      const page = Number(url.searchParams.get('page') || 1);
      const t = (id) => ({ id: String(id), channel_id: String(account.channels[0].id), template_name: `t${id}`, header_format: 'text', language_code: 'ar', template_category: 'utility', status: 'APPROVED', template_body: 'مرحباً {{1}}، تم رفع طلبك لدى {{2}}.', created_at: 'x' });
      return json(200, { data: { templates: page === 1 ? [t(1)] : [t(2)] }, meta: { hasMorePages: page === 1 } });
    }
    if (req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      sent.push({ path: url.pathname, body: b, token });
      const ch = b.account_channel_id ?? b.channel_id;
      if (!account.channels.some((c) => c.id === ch)) {
        return json(422, { message: 'account_channel_id must belong to a WhatsApp Business API channel.', errors: { account_channel_id: ['account_channel_id must belong to a WhatsApp Business API channel.'] } });
      }
      // What LoopChat does before it answers the send (an echo of the message).
      return Promise.resolve(beforeAnswer?.(b)).then(() => {
        if (sendResult === 'sent') return json(202, { data: { status: 'sent', message_id: 900 + sent.length, contact_id: matchedContact, channel_id: ch } });
        return json(202, { data: { status: 'failed', message_id: 5, failure_reason: 'The 24-hour window is closed. Please use a WhatsApp template to contact this customer.', contact_id: matchedContact, channel_id: ch } });
      });
    }
    json(404, {});
  });
});

let sql; let db; let wa; let loopchat;
const replies = [];
// Estate, as test-estate.js stubs it: what was posted, and Estate's answer.
const estatePosts = [];
const deps = (over = {}) => ({
  sql,
  logger: { info() {}, warn() {}, error() {} },
  listCompanies: async () => require('../companies').listCompaniesFull(),
  askReply: async (company, text, history, vars, opts) => { replies.push({ company: company.id, text, history, vars, opts }); return { reply: `رد على: ${text}` }; },
  loadSessionHistory: async () => [],
  checkAndBumpUsage: async () => true,
  dailyCap: () => 2000,
  decryptField: (v) => v,
  encryptField: (v) => v,
  featureEnabled: (...a) => require('../services/features/store').featureEnabled(...a),
  fillGlobals: (t) => t.replace('{{agent_name}}', 'جداوي'),
  post: async (origin, token, form) => { estatePosts.push({ origin, token, form: Object.fromEntries(form) }); return { status: 200, data: { status: true, message: 'تمت العملية بنجاح' } }; },
  ...over,
});

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.LOOPCHAT_API_BASE = `http://127.0.0.1:${fake.address().port}/api`;
  ({ sql, db } = require('../db'));
  wa = require('../services/whatsapp');
  loopchat = require('../services/whatsapp/loopchat');
  const settings = JSON.stringify({ whatsappChannelId: 6, whatsappAutoReply: true });
  db.prepare("INSERT INTO companies (id, name, language, system_prompt, settings) VALUES ('maheer', 'مهير العقارية', 'ar', '', ?)").run(settings);
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('wakan', 'وكن', 'ar', '')").run();
});
after(() => {
  fake.close();
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});
beforeEach(() => {
  sent.length = 0; replies.length = 0; estatePosts.length = 0; sendResult = 'sent'; matchedContact = 101; beforeAnswer = null;
  require('../companies').invalidateCache();
});

let eventSeq = 0;
const incoming = (text, { phone = '966501234567', channel = 6, type = 'text', id, conversation, at } = {}) => ({
  event_type: 'message.received',
  event_id: id || `evt-${++eventSeq}`,
  contact: { id: 101, name: 'أبو فهد', phone, email: null },
  message: { messageId: 765607, traffic: 'incoming', timestamp: at ?? Date.now(), message: { type, text, attachments: type === 'text' ? undefined : { url: 'https://x/y.jpg', name: 'y.jpg', mimeType: 'image/jpeg' } } },
  channel: { id: channel, name: 'WhatsApp', source: 'whatsapp' },
  // The documented message event names no conversation; the tests that pass
  // one cover a payload that does.
  ...(conversation ? { conversation: { id: conversation } } : {}),
});
const messages = () => db.prepare('SELECT * FROM whatsapp_messages ORDER BY id').all();
const setSettings = (id, s) => { db.prepare('UPDATE companies SET settings = ? WHERE id = ?').run(JSON.stringify(s), id); require('../companies').invalidateCache(); };

// ─── (أ) replies ──────────────────────────────────────────────────
test('a customer message on the company\'s number is answered through LoopChat', async () => {
  const r = await wa.handleEvent(incoming('كم سعر الشقة؟'), deps());
  assert.deepEqual(r, { sent: true });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].company, 'maheer');
  assert.equal(replies[0].vars.customer_name, 'أبو فهد');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/api/v2/integrations/messages/send');
  assert.deepEqual(sent[0].body, { account_channel_id: 6, phone_number: '966501234567', type: 'text', content: 'رد على: كم سعر الشقة؟' });
  const rows = messages().slice(-2);
  assert.equal(rows[0].direction, 'in'); assert.equal(rows[0].status, 'received'); assert.equal(rows[0].body, 'كم سعر الشقة؟');
  assert.equal(rows[1].direction, 'out'); assert.equal(rows[1].status, 'sent'); assert.equal(rows[1].kind, 'text');
  const chat = db.prepare("SELECT * FROM chats WHERE session_id = 'wa-966501234567' ORDER BY id DESC").get();
  assert.equal(chat.channel, 'whatsapp');
  assert.equal(chat.assistant_reply, 'رد على: كم سعر الشقة؟');
});

test('a redelivered event is answered once', async () => {
  const evt = incoming('مرحبا', { id: 'evt-same' });
  await wa.handleEvent(evt, deps());
  const again = await wa.handleEvent(evt, deps());
  assert.deepEqual(again, { duplicate: true });
  assert.equal(sent.length, 1);
});

test('a number no company uses is ignored, and nothing is recorded', async () => {
  const before = messages().length;
  assert.deepEqual(await wa.handleEvent(incoming('هلا', { channel: 99 }), deps()), { ignored: 'unmapped channel' });
  assert.equal(messages().length, before);
  assert.equal(sent.length, 0);
});

// As it is live: Wakan's number (182) is in Wakan's own LoopChat account,
// Maheer's (6 here) in the account the server's token reaches.
test('a company with its own LoopChat account is answered through its own token, from its own number', async () => {
  setSettings('wakan', { whatsappChannelId: 182, whatsappAutoReply: true });
  db.prepare("UPDATE companies SET loopchat_token = 'lc-wakan-token' WHERE id = 'wakan'").run();
  try {
    assert.deepEqual(await wa.handleEvent(incoming('السلام عليكم', { channel: 182, phone: '966507777777' }), deps()), { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].token, 'lc-wakan-token');
    assert.equal(sent[0].body.account_channel_id, 182);
    assert.equal(replies.at(-1).company, 'wakan');
    // Maheer, with no token of its own, still goes through the server's.
    assert.deepEqual(await wa.handleEvent(incoming('هلا'), deps()), { sent: true });
    assert.equal(sent[1].token, 'lc-test-token');
    assert.equal(sent[1].body.account_channel_id, 6);
  } finally {
    db.prepare("UPDATE companies SET loopchat_token = NULL WHERE id = 'wakan'").run();
    setSettings('wakan', {});
  }
});

test('a company whose number is in another account is refused there, never answered from someone else\'s number', async () => {
  // Wakan linked to 182 but without its token: the server's account does not
  // have 182, so LoopChat refuses -- nothing goes out.
  setSettings('wakan', { whatsappChannelId: 182, whatsappAutoReply: true });
  try {
    const r = await wa.handleEvent(incoming('هلا', { channel: 182, phone: '966506666660' }), deps());
    assert.match(r.failed, /account_channel_id must belong/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].token, 'lc-test-token');
    assert.equal(messages().at(-1).status, 'failed');
  } finally { setSettings('wakan', {}); }
});

test('the template after a call goes through the company\'s own token too', async () => {
  setSettings('wakan', { whatsappChannelId: 182, whatsappFollowup: { trigger: 'answered', templateId: 1, variables: [] } });
  db.prepare("UPDATE companies SET loopchat_token = 'lc-wakan-token' WHERE id = 'wakan'").run();
  try {
    const id = `conv-wakan-${Date.now()}`;
    db.prepare(`INSERT INTO calls (id, company_id, caller_number, duration_sec, transcript, direction, created_at)
                VALUES (?, 'wakan', '0501112233', 60, 'وكيل: هلا', 'inbound', ?)`).run(id, new Date().toISOString().replace('T', ' ').slice(0, 19));
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
    const company = await require('../companies').loadCompany('wakan');
    assert.deepEqual(await wa.afterCall(company, call, deps()), { sent: true });
    assert.equal(sent.at(-1).path, '/api/v2/integrations/templates/send');
    assert.equal(sent.at(-1).token, 'lc-wakan-token');
    assert.equal(sent.at(-1).body.channel_id, 182);
  } finally {
    db.prepare("UPDATE companies SET loopchat_token = NULL WHERE id = 'wakan'").run();
    setSettings('wakan', {});
  }
});

test('the LoopChat client reaches the account of the token it is given', async () => {
  assert.deepEqual((await loopchat.listChannels('lc-wakan-token')).map((c) => c.id), [182]);
  assert.deepEqual((await loopchat.listChannels()).map((c) => c.id), [6]);
  await assert.rejects(loopchat.listChannels('lc-wrong'), (e) => e.response?.status === 401);
});
test('a refusal names it when LoopChat matched the number to someone other than who wrote', async () => {
  sendResult = 'failed'; matchedContact = 555;
  const r = await wa.handleEvent(incoming('هلا', { phone: '966503333333' }), deps());
  assert.match(r.failed, /24-hour window.*جهة الاتصال #555، والتي راسلت هي #101/);
  matchedContact = 101;
  const same = await wa.handleEvent(incoming('هلا', { phone: '966503333334' }), deps());
  assert.doesNotMatch(same.failed, /جهة الاتصال/);
});

test('with replies switched off the message is counted but not answered', async () => {
  setSettings('maheer', { whatsappChannelId: 6, whatsappAutoReply: false });
  try {
    assert.deepEqual(await wa.handleEvent(incoming('هلا'), deps()), { skipped: 'auto-reply off' });
    assert.equal(sent.length, 0);
    assert.equal(messages().at(-1).direction, 'in');
  } finally { setSettings('maheer', { whatsappChannelId: 6, whatsappAutoReply: true }); }
});

test('a picture or a voice note is left to the team', async () => {
  assert.deepEqual(await wa.handleEvent(incoming('', { type: 'image' }), deps()), { skipped: 'not text' });
  assert.equal(sent.length, 0);
  assert.equal(messages().at(-1).kind, 'media');
});

const handover = (type, phone, conversation = 1) => ({
  event_type: type, event_id: `h-${++eventSeq}`, conversation: { id: conversation }, contact: { id: 2, phone }, channel: { id: 6 },
  ...(type.endsWith('stopped') ? { stopped_by: { id: 12, name: 'سارة' } } : { started_by: { id: 13, name: 'نورة' } }),
});

test('while an employee has the conversation, its messages are left to them until it is handed back', async () => {
  const phone = '966509999999';
  const stopped = await wa.handleEvent(handover('message_integration.stopped', phone), deps());
  assert.deepEqual(stopped, { paused: true, by: 'سارة' });
  // A message LoopChat names as the same conversation: the employee is in it.
  const quiet = await wa.handleEvent(incoming('أبي موظف', { phone, conversation: 1 }), deps());
  assert.deepEqual(quiet, { skipped: 'taken over by staff', by: 'سارة' });
  assert.equal(sent.length, 0);
  // The page names who paused it, and how it ends.
  assert.match(wa.describeOutcome(stopped).text, /أوقف موظف \(سارة\).*أول رسالة جديدة بعد إغلاق المحادثة/);
  assert.match(wa.describeOutcome(quiet).text, /المحادثة نفسها ما زالت عند موظف \(سارة\)/);
  const started = await wa.handleEvent(handover('message_integration.started', phone), deps());
  assert.deepEqual(started, { paused: false, by: 'نورة' });
  assert.match(wa.describeOutcome(started).text, /أعاد موظف \(نورة\)/);
  assert.deepEqual(await wa.handleEvent(incoming('رجعت', { phone, conversation: 1 }), deps()), { sent: true });
});

// LoopChat's request of 2026-10-23: stopped, then the conversation closed in
// LoopChat, and the customer's next message went unanswered for good.
test('a new message after the conversation was closed brings the assistant back, and is answered', async () => {
  const phone = '966509999998';
  await wa.handleEvent(handover('message_integration.stopped', phone, 41), deps());
  // A new conversation...
  const r = await wa.handleEvent(incoming('السلام عليكم، عندي سؤال', { phone, conversation: 42 }), deps());
  assert.deepEqual(r, { sent: true, resumed: true });
  assert.match(wa.describeOutcome(r).text, /وصلت رسالة جديدة بعد إيقافها، فعاد المساعد إليها/);
  const t = db.prepare('SELECT * FROM whatsapp_threads WHERE channel_id = 6 AND contact_phone = ?').get(phone);
  assert.equal(Number(t.ai_paused), 0);
  assert.equal(t.conversation_id, '42');
  // ...and the conversation goes on with the assistant.
  assert.deepEqual(await wa.handleEvent(incoming('وكم السعر؟', { phone, conversation: 42 }), deps()), { sent: true });
});

test('a message that names no conversation, as LoopChat documents it, brings the assistant back too', async () => {
  const phone = '966509999997';
  await wa.handleEvent(handover('message_integration.stopped', phone), deps());
  assert.deepEqual(await wa.handleEvent(incoming('هلا', { phone }), deps()), { sent: true, resumed: true });
});

test('a message older than the pause, or one delivered again, does not end it', async () => {
  const phone = '966509999996';
  // Seen once before the employee stopped the assistant...
  const early = incoming('سؤال قديم', { phone, id: 'evt-early' });
  await wa.handleEvent(early, deps());
  await wa.handleEvent(handover('message_integration.stopped', phone), deps());
  const repliesBefore = replies.length;
  // ...LoopChat sending it again changes nothing.
  assert.deepEqual(await wa.handleEvent(early, deps()), { duplicate: true });
  // A message written before the pause, delivered after it, does not either.
  const late = await wa.handleEvent(incoming('رسالة متأخرة', { phone, at: Date.now() - 60 * 60 * 1000 }), deps());
  assert.deepEqual(late, { skipped: 'taken over by staff', by: 'سارة', older: true });
  assert.match(wa.describeOutcome(late).text, /وصلت متأخرة/);
  assert.equal(replies.length, repliesBefore);
  const t = db.prepare('SELECT ai_paused FROM whatsapp_threads WHERE channel_id = 6 AND contact_phone = ?').get(phone);
  assert.equal(Number(t.ai_paused), 1);
});

test('a message time given in seconds is read as such, so it can still end a pause', async () => {
  const phone = '966509999994';
  await wa.handleEvent(handover('message_integration.stopped', phone), deps());
  const r = await wa.handleEvent(incoming('هلا', { phone, at: Math.floor(Date.now() / 1000) + 5 }), deps());
  assert.deepEqual(r, { sent: true, resumed: true });
});

test('a pause ended by a message is said even when that message itself is not answered', async () => {
  const phone = '966509999995';
  await wa.handleEvent(handover('message_integration.stopped', phone), deps());
  const r = await wa.handleEvent(incoming('', { phone, type: 'image' }), deps());
  assert.deepEqual(r, { skipped: 'not text', resumed: true });
  assert.match(wa.describeOutcome(r).text, /ليست رسالة نصية.*وعادت المحادثة إلى المساعد/);
});

// An employee answering from LoopChat by hand: the assistant steps back in
// that conversation.
const outgoing = (text, phone, conversation) => ({
  event_type: 'message.received', event_id: `o-${++eventSeq}`,
  contact: { id: 101, phone },
  message: { messageId: 1, traffic: 'outgoing', timestamp: Date.now(), message: { type: 'text', text }, user: { name: 'نورة' } },
  channel: { id: 6, name: 'WhatsApp', source: 'whatsapp' },
  ...(conversation ? { conversation: { id: conversation } } : {}),
});

test('an employee writing from LoopChat silences the assistant in that conversation', async () => {
  const phone = '966502222222';
  assert.deepEqual(await wa.handleEvent(outgoing('أهلاً، معك نورة من المبيعات', phone, 9), deps()), { paused: true, by: 'نورة' });
  assert.deepEqual(await wa.handleEvent(incoming('هلا نورة', { phone, conversation: 9 }), deps()), { skipped: 'taken over by staff', by: 'نورة' });
  assert.equal(sent.length, 0);
});

test('the assistant\'s own reply coming back from LoopChat is not taken for an employee', async () => {
  const phone = '966502222223';
  assert.deepEqual(await wa.handleEvent(incoming('كم سعر الشقة؟', { phone }), deps()), { sent: true });
  // LoopChat reports the reply just sent as an outgoing message.
  const echo = await wa.handleEvent(outgoing('رد على: كم سعر الشقة؟', phone), deps());
  assert.deepEqual(echo, { ignored: 'own reply' });
  assert.equal(wa.describeOutcome(echo).ok, true);
  // So the next question is still answered.
  assert.deepEqual(await wa.handleEvent(incoming('وفيه تقسيط؟', { phone }), deps()), { sent: true });
  // Different words from the same number are an employee.
  assert.deepEqual(await wa.handleEvent(outgoing('سأتصل بك الآن', phone), deps()), { paused: true, by: 'نورة' });
});

// The assistant went quiet for good after one of its own replies: LoopChat
// reported the reply before answering the send, inside the same conversation.
test('its own reply reported before LoopChat answers the send, or with its lines rewrapped, is still its own', async () => {
  const phone = '966502222224';
  const echoes = [];
  beforeAnswer = async (b) => { echoes.push(await wa.handleEvent(outgoing(String(b.content).replace(/ /, '\r\n '), phone, 77), deps())); };
  assert.deepEqual(await wa.handleEvent(incoming('أبي أسجّل اهتمام', { phone, conversation: 77 }), deps()), { sent: true });
  assert.deepEqual(echoes, [{ ignored: 'own reply' }]);
  assert.deepEqual(await wa.handleEvent(incoming('اسمي فهد', { phone, conversation: 77 }), deps()), { sent: true });
  // A reply LoopChat refused was never sent, so the same words afterwards are someone's.
  beforeAnswer = null; sendResult = 'failed';
  await wa.handleEvent(incoming('تمام', { phone, conversation: 77 }), deps());
  assert.deepEqual(await wa.handleEvent(outgoing('رد على: تمام', phone, 77), deps()), { paused: true, by: 'نورة' });
});

test('a message LoopChat marks incoming is the customer\'s, whatever the event is called', async () => {
  const phone = '966502222225';
  const evt = { ...incoming('مرحبا', { phone, conversation: 78 }), event_type: 'message.created' };
  assert.deepEqual(await wa.handleEvent(evt, deps()), { ignored: 'message.created' });
  assert.deepEqual(await wa.handleEvent(incoming('أبي أسأل عن مشروع', { phone, conversation: 78 }), deps()), { sent: true });
});
test('the LoopChat client finds a contact by number, with its integration switch', async () => {
  integrationSwitch.set('966501010101', false);
  try {
    assert.deepEqual(await loopchat.findContact('+966 50 101 0101'), { id: 101, name: 'أبو فهد', messageIntegration: false });
    assert.equal(await loopchat.findContact('966509999990'), null);
  } finally { integrationSwitch.delete('966501010101'); }
});

test('a reply LoopChat refuses is recorded with its reason and kept out of the conversation', async () => {
  sendResult = 'failed';
  const r = await wa.handleEvent(incoming('سؤال', { phone: '966508888888' }), deps());
  assert.match(r.failed, /24-hour window/);
  const out = messages().at(-1);
  assert.equal(out.status, 'failed');
  assert.match(out.detail, /24-hour window/);
  const chat = db.prepare("SELECT * FROM chats WHERE session_id = 'wa-966508888888'").get();
  assert.equal(chat.assistant_reply, '');
});

test('every outcome of an event reads as a reason on the WhatsApp page', async () => {
  const say = (r) => wa.describeOutcome(r);
  assert.deepEqual(say({ sent: true }).ok, true);
  assert.match(say(await wa.handleEvent(incoming('هلا', { channel: 99 }), deps())).text, /غير مربوط بأي شركة/);
  assert.match(say({ skipped: 'auto-reply off' }).text, /غير مفعّل/);
  assert.match(say({ skipped: 'taken over by staff' }).text, /موظف/);
  assert.match(say({ failed: 'Insufficient wallet balance.' }).text, /LoopChat: Insufficient wallet balance/);
  assert.match(say(await wa.handleEvent(null, deps())).text, /بلا نوع حدث/);
  assert.match(say(await wa.handleEvent({ event_type: 'contact.updated' }, deps())).text, /لا يخص المساعد: contact\.updated/);
  assert.match(say(null).text, /سجل الخادم/);
  assert.equal(say({ failed: 'no scenario' }).text, 'لا يوجد سيناريو مفعّل للشركة');
  const noScenario = { ...deps(), askReply: async () => { throw Object.assign(new Error('x'), { code: 'NO_ACTIVE_SCENARIO' }); } };
  assert.deepEqual(await wa.handleEvent(incoming('هلا', { phone: '966506666666' }), noScenario), { failed: 'no scenario' });
  assert.equal(messages().at(-1).detail, 'لا يوجد سيناريو مفعّل للشركة');
  assert.equal(say({ paused: true }).ok, true);
  for (const r of [{ skipped: 'auto-reply off' }, { ignored: 'unmapped channel' }, { failed: 'reply' }]) assert.equal(say(r).ok, false);
});

// ─── (ب) the template after a call ─────────────────────────────────
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
let callSeq = 0;
function call(extra = {}) {
  const id = `conv-${++callSeq}`;
  db.prepare(`INSERT INTO calls (id, company_id, caller_number, duration_sec, transcript, direction, created_at)
              VALUES (?, 'maheer', ?, ?, ?, 'inbound', ?)`)
    .run(id, extra.number ?? '0501234567', extra.dur ?? 60, 'transcript' in extra ? extra.transcript : 'وكيل: هلا', extra.created_at ?? now());
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
}
const followup = (extra = {}) => ({
  whatsappChannelId: 6, whatsappAutoReply: true,
  whatsappFollowup: { trigger: 'request', templateId: 1, variables: [{ source: 'customer_name', text: 'عميلنا' }, { source: 'company_name', text: '' }], ...extra },
});
const company = () => require('../companies').loadCompany('maheer');

test('after a call where the agent filed a request, the chosen template goes to the customer once', async () => {
  setSettings('maheer', followup());
  const c = call();
  db.prepare("INSERT INTO customer_requests (company_id, conversation_id, request_type, customer_name, fields) VALUES ('maheer', ?, 'interest', 'خالد', '{}')").run(c.id);
  assert.deepEqual(await wa.afterCall(await company(), c, deps()), { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/api/v2/integrations/templates/send');
  assert.deepEqual(sent[0].body, { channel_id: 6, template_id: 1, phone: '+966501234567', variables: { 1: 'خالد', 2: 'مهير العقارية' } });
  assert.deepEqual(await wa.afterCall(await company(), c, deps()), { duplicate: true });
  assert.equal(sent.length, 1);
  const row = db.prepare('SELECT * FROM whatsapp_messages WHERE call_id = ?').get(c.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.kind, 'template');
});

test('no request filed, no template (on the request trigger)', async () => {
  setSettings('maheer', followup());
  assert.deepEqual(await wa.afterCall(await company(), call(), deps()), { skipped: 'no request filed' });
  assert.equal(sent.length, 0);
});

test('on the "every answered call" trigger an unanswered call gets nothing', async () => {
  setSettings('maheer', followup({ trigger: 'answered' }));
  assert.deepEqual(await wa.afterCall(await company(), call({ dur: 0, transcript: null }), deps()), { skipped: 'not answered' });
  assert.deepEqual(await wa.afterCall(await company(), call(), deps()), { sent: true });
});

test('an old call replayed through the pipeline never messages the customer', async () => {
  setSettings('maheer', followup({ trigger: 'answered' }));
  assert.deepEqual(await wa.afterCall(await company(), call({ created_at: '2026-01-01 10:00:00' }), deps()), { skipped: 'call too old' });
  assert.equal(sent.length, 0);
});

test('a landline is not sent to, and the reason is recorded', async () => {
  setSettings('maheer', followup({ trigger: 'answered' }));
  const c = call({ number: '0114567890' });
  assert.deepEqual(await wa.afterCall(await company(), c, deps()), { skipped: 'not a mobile' });
  assert.equal(sent.length, 0);
  assert.match(db.prepare('SELECT detail FROM whatsapp_messages WHERE call_id = ?').get(c.id).detail, /جوال/);
});

test('a variable with no value falls back to its text', async () => {
  setSettings('maheer', followup({ trigger: 'answered' }));
  await wa.afterCall(await company(), call(), deps());
  assert.equal(sent[0].body.variables['1'], 'عميلنا');
});

// ─── Pieces ───────────────────────────────────────────────────────
test('numbers are normalised for WhatsApp; Saudi landlines are refused', () => {
  assert.equal(wa.whatsappNumber('0501234567'), '966501234567');
  assert.equal(wa.whatsappNumber('+966 50 123 4567'), '966501234567');
  assert.equal(wa.whatsappNumber('00966501234567'), '966501234567');
  assert.equal(wa.whatsappNumber('501234567'), '966501234567');
  assert.equal(wa.whatsappNumber('966501234567'), '966501234567');
  assert.equal(wa.whatsappNumber('+966114567890'), null);
  assert.equal(wa.whatsappNumber('0114567890'), null);
  assert.equal(wa.whatsappNumber('920033842'), null);
  assert.equal(wa.whatsappNumber('8001234567'), null);
  assert.equal(wa.whatsappNumber('+971501234567'), '971501234567');
  assert.equal(wa.whatsappNumber('00971501234567'), '971501234567');
  assert.equal(wa.whatsappNumber('123'), null);
});

test('settings are validated before they are stored', () => {
  assert.match(wa.validateSettings({ channelId: 'abc' }).error, /قناة/);
  assert.match(wa.validateSettings({ channelId: 6, followup: { trigger: 'request' } }).error, /قالب/);
  assert.match(wa.validateSettings({ followup: { trigger: 'request', templateId: 1 } }).error, /قناة/);
  assert.match(wa.validateSettings({ channelId: 6, followup: { trigger: 'bogus' } }).error, /توقيت/);
  const ok = wa.validateSettings({ channelId: 6, autoReply: true, followup: { trigger: 'answered', templateId: 3, variables: [{ source: 'nope', text: 'x' }] } });
  assert.deepEqual(ok.settings.whatsappFollowup.variables, [{ source: 'fixed', text: 'x' }]);
  // Replies need a number to reply from.
  assert.equal(wa.validateSettings({ channelId: null, autoReply: true }).settings.whatsappAutoReply, false);
});

test('the LoopChat client reads every page of templates and counts their variables', async () => {
  const t = await loopchat.listTemplates();
  assert.deepEqual(t.map((x) => x.id), [1, 2]);
  assert.equal(t[0].variables, 2);
  assert.equal(t[0].channelId, 6);
  assert.equal(loopchat.templateVariableCount('بدون متغيرات'), 0);
  assert.deepEqual((await loopchat.listChannels())[0], { id: 6, name: 'WhatsApp 1', phoneNumber: '+966920031118', hasActiveBot: false });
});

// ─── (د) requests on WhatsApp ─────────────────────────────────────
// The reply model gets the call agent's request tool; what it files lands on
// the requests page with the WhatsApp number, and goes on to Estate.
const M10 = 'M-10 — أدوار، حي المغرزات';
function withRequests(on) {
  setSettings('maheer', {
    whatsappChannelId: 6, whatsappAutoReply: true,
    estate: { url: 'https://maher.e-statee.com', enabled: true, projects: [{ name: M10, code: 'M-10' }] },
  });
  db.prepare("UPDATE companies SET estate_token = 'estate-key' WHERE id = 'maheer'").run();
  db.prepare(`INSERT INTO company_features (company_id, feature_key, enabled) VALUES ('maheer', 'request_creation', ?)
              ON CONFLICT(company_id, feature_key) DO UPDATE SET enabled = excluded.enabled`).run(on ? 1 : 0);
}
// A model that files what it is given, then answers.
const filing = (args) => async (company, text, history, vars, opts) => {
  replies.push({ company: company.id, text, opts });
  const r = await opts.runTool(opts.tools[0].function.name, JSON.stringify(args));
  return { reply: r };
};
const waRequests = (phone) => db.prepare("SELECT * FROM customer_requests WHERE company_id = 'maheer' AND channel = 'whatsapp' AND contact_phone = ? ORDER BY id").all(`+${phone}`);

test('a customer who confirms a purchase on WhatsApp files a request that goes to Estate with the WhatsApp number', async () => {
  withRequests(true);
  const phone = '966551112223';
  const r = await wa.handleEvent(incoming('إيه صح، أكّد الطلب', { phone }), deps({
    askReply: filing({ request_type: 'interest', customer_confirmed: true, customer_name: 'أبو فهد', project: M10, payment_method: 'كاش' }),
  }));
  assert.equal(r.sent, true);
  assert.equal(r.requests.length, 1);
  assert.deepEqual(r.estate, [{ sent: true }]);
  assert.match(wa.describeOutcome(r).text, /أُرسل إلى Estate/);

  // The tool the model saw: the call agent's, with this company's projects.
  const tool = replies[0].opts.tools[0].function;
  assert.equal(tool.name, 'submit_customer_request');
  assert.ok(tool.parameters.properties.project.enum.includes(M10));
  assert.match(tool.description, /يُسجَّل تلقائياً من محادثة واتساب/);
  assert.deepEqual(tool.parameters.required, ['request_type', 'customer_confirmed']);

  const [row] = waRequests(phone);
  assert.equal(row.request_type, 'interest');
  assert.equal(row.customer_name, 'أبو فهد');
  assert.match(row.conversation_id, /^wa:6:966551112223:\d{4}-\d{2}-\d{2}$/);
  assert.equal(row.estate_status, 'sent');
  // On the requests page with its number, like a call's.
  const listed = sql.listCustomerRequests.all('maheer').find((x) => x.id === row.id);
  assert.equal(listed.caller_number, '+966551112223');
  assert.equal(listed.channel, 'whatsapp');

  assert.equal(estatePosts.length, 1);
  const f = estatePosts[0].form;
  assert.equal(f.name, 'أبو فهد');
  assert.equal(f.phone, '966551112223');
  assert.equal(f['project_codes[0]'], 'M-10');
  assert.equal(f.platform, 'ai_chat');
  assert.deepEqual(f.note.split('\n').slice(0, 2), ['طلب اهتمام من محادثة واتساب', 'المساعد الذكي: ناصر — مهير العقارية']);
  assert.match(f.note, /طريقة الدفع: كاش/);
  // The customer read the confirmation the model wrote after filing.
  assert.match(sent.at(-1).body.content, /تم تسجيل الطلب/);
});

test('a second confirmation the same day updates that request, and Estate is not sent it twice', async () => {
  withRequests(true);
  const phone = '966551112224';
  const once = { request_type: 'interest', customer_confirmed: true, customer_name: 'أبو سعد', project: M10 };
  await wa.handleEvent(incoming('أكد', { phone }), deps({ askReply: filing(once) }));
  await wa.handleEvent(incoming('وأبيه كاش', { phone }), deps({ askReply: filing({ ...once, payment_method: 'كاش' }) }));
  const rows = waRequests(phone);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].fields), { customer_name: 'أبو سعد', project: M10, payment_method: 'كاش' });
  assert.equal(estatePosts.length, 1);
});

test('without «استقبال الطلبات» no tool is offered; unconfirmed, nothing is filed', async () => {
  withRequests(false);
  await wa.handleEvent(incoming('أبي أشتري', { phone: '966551112225' }), deps());
  assert.equal(replies.at(-1).opts.tools, undefined);

  withRequests(true);
  const phone = '966551112226';
  const r = await wa.handleEvent(incoming('أبي أشتري', { phone }), deps({
    askReply: filing({ request_type: 'interest', customer_confirmed: false, customer_name: 'أبو خالد' }),
  }));
  assert.equal(r.requests, undefined);
  assert.equal(waRequests(phone).length, 0);
  assert.match(sent.at(-1).body.content, /لم يُسجَّل الطلب بعد/);
  assert.equal(estatePosts.length, 0);
  withRequests(false);
  setSettings('maheer', { whatsappChannelId: 6, whatsappAutoReply: true });
});

// ─── (ج) the counts ───────────────────────────────────────────────
test('the usage query counts received, replied, templated and failed apart', () => {
  const r = sql.whatsappUsageByCompanyInRange.all({ from: '2000-01-01 00:00:00', to: '2100-01-01 00:00:00', company_id: 'maheer' });
  assert.equal(r.length, 1);
  const all = messages().filter((m) => m.company_id === 'maheer');
  assert.equal(r[0].received, all.filter((m) => m.direction === 'in').length);
  assert.equal(r[0].replies, all.filter((m) => m.direction === 'out' && m.kind === 'text' && m.status === 'sent').length);
  assert.equal(r[0].templates, all.filter((m) => m.kind === 'template' && m.status === 'sent').length);
  assert.equal(r[0].failed, all.filter((m) => m.direction === 'out' && m.status === 'failed').length);
  assert.ok(r[0].received > 0 && r[0].replies > 0 && r[0].templates > 0 && r[0].failed > 0);
});
