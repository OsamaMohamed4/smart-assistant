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
      if (sendResult === 'sent') return json(202, { data: { status: 'sent', message_id: 900 + sent.length, contact_id: matchedContact, channel_id: ch } });
      return json(202, { data: { status: 'failed', message_id: 5, failure_reason: 'The 24-hour window is closed. Please use a WhatsApp template to contact this customer.', contact_id: matchedContact, channel_id: ch } });
    }
    json(404, {});
  });
});

let sql; let db; let wa; let loopchat;
const replies = [];
const deps = () => ({
  sql,
  logger: { info() {}, warn() {}, error() {} },
  listCompanies: async () => require('../companies').listCompaniesFull(),
  askReply: async (company, text, history, vars) => { replies.push({ company: company.id, text, history, vars }); return { reply: `رد على: ${text}` }; },
  loadSessionHistory: async () => [],
  checkAndBumpUsage: async () => true,
  dailyCap: () => 2000,
  decryptField: (v) => v,
  fillGlobals: (t) => t.replace('{{agent_name}}', 'جداوي'),
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
  sent.length = 0; replies.length = 0; sendResult = 'sent'; matchedContact = 101;
  require('../companies').invalidateCache();
});

let eventSeq = 0;
const incoming = (text, { phone = '966501234567', channel = 6, type = 'text', id } = {}) => ({
  event_type: 'message.received',
  event_id: id || `evt-${++eventSeq}`,
  contact: { id: 101, name: 'أبو فهد', phone, email: null },
  message: { messageId: 765607, traffic: 'incoming', timestamp: Date.now(), message: { type, text, attachments: type === 'text' ? undefined : { url: 'https://x/y.jpg', name: 'y.jpg', mimeType: 'image/jpeg' } } },
  channel: { id: channel, name: 'WhatsApp', source: 'whatsapp' },
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

test('once an employee takes the conversation over, the assistant stays quiet until it is handed back', async () => {
  const phone = '966509999999';
  const handover = (type) => ({
    event_type: type, event_id: `h-${++eventSeq}`, conversation: { id: 1 }, contact: { id: 2, phone }, channel: { id: 6 },
    ...(type.endsWith('stopped') ? { stopped_by: { id: 12, name: 'سارة' } } : { started_by: { id: 13, name: 'نورة' } }),
  });
  const stopped = await wa.handleEvent(handover('message_integration.stopped'), deps());
  assert.deepEqual(stopped, { paused: true, by: 'سارة' });
  const quiet = await wa.handleEvent(incoming('أبي موظف', { phone }), deps());
  assert.deepEqual(quiet, { skipped: 'taken over by staff', by: 'سارة', live: null });
  assert.equal(sent.length, 0);
  // The page names who paused it, and how it ends.
  assert.match(wa.describeOutcome(stopped).text, /أوقف موظف \(سارة\).*يعيد الموظف تشغيل التكامل/);
  assert.match(wa.describeOutcome(quiet).text, /متوقفة عند موظف \(سارة\).*أعد تشغيل التكامل/);
  const started = await wa.handleEvent(handover('message_integration.started'), deps());
  assert.deepEqual(started, { paused: false, by: 'نورة' });
  assert.match(wa.describeOutcome(started).text, /أعاد موظف \(نورة\)/);
  assert.deepEqual(await wa.handleEvent(incoming('رجعت', { phone }), deps()), { sent: true });
});

// As it happened on Maheer's number: paused by an event, then -- while the
// webhook pointed at a dead domain -- handed back in LoopChat, and the
// hand-back never arrived.
test('a pause LoopChat no longer holds is lifted, and the customer answered', async () => {
  const phone = '966502222222';
  await wa.handleEvent({ event_type: 'message_integration.stopped', event_id: `h-${++eventSeq}`, contact: { phone }, channel: { id: 6 }, stopped_by: { name: 'Lama Mohsen' } }, deps());
  integrationSwitch.set(phone, true);
  try {
    const r = await wa.handleEvent(incoming('هلا', { phone }), deps());
    assert.deepEqual(r, { sent: true, resumed: true });
    assert.match(wa.describeOutcome(r).text, /LoopChat يقول إن التكامل يعمل لها/);
    assert.equal(Number(db.prepare('SELECT ai_paused FROM whatsapp_threads WHERE channel_id = 6 AND contact_phone = ?').get(phone).ai_paused), 0);
    // And the next message is answered without asking again.
    assert.deepEqual(await wa.handleEvent(incoming('ثانية', { phone }), deps()), { sent: true });
  } finally { integrationSwitch.delete(phone); }
});

test('a pause LoopChat confirms holds, and the page says LoopChat confirmed it', async () => {
  const phone = '966502222223';
  await wa.handleEvent({ event_type: 'message_integration.stopped', event_id: `h-${++eventSeq}`, contact: { phone }, channel: { id: 6 }, stopped_by: { name: 'Lama Mohsen' } }, deps());
  integrationSwitch.set(phone, false);
  try {
    const r = await wa.handleEvent(incoming('هلا', { phone }), deps());
    assert.deepEqual(r, { skipped: 'taken over by staff', by: 'Lama Mohsen', live: false });
    assert.match(wa.describeOutcome(r).text, /\(Lama Mohsen\).*LoopChat يؤكد أن التكامل متوقف/);
    assert.equal(sent.length, 0);
  } finally { integrationSwitch.delete(phone); }
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
