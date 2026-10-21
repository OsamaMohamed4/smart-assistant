// Requests sent on to the company's own Estate: what is sent, what is not and
// why, once per request, and what Estate said -- kept on the request.
//
// Real statements on a throwaway SQLite DB; Estate is a stub standing in for
// the HTTP call (deps.post), answering the way Estate's Laravel API does.
//
//   node --test scripts/test-estate.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-estate-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;

let sql; let db; let estate;
const posts = [];
let answer = () => ({ status: 200, data: { status: true, message: 'تمت العملية بنجاح' } });
const fakePost = async (origin, token, form) => {
  posts.push({ origin, token, form: Object.fromEntries(form) });
  const a = answer();
  if (a instanceof Error) throw a;
  return a;
};
const deps = () => ({ sql, logger: { info() {}, warn() {}, error() {} }, decryptField: (v) => v, post: fakePost });

before(() => {
  ({ sql, db } = require('../db'));
  estate = require('../services/estate');
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('maheer', 'مهير', 'ar', '')").run();
});
after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});
beforeEach(() => {
  posts.length = 0;
  answer = () => ({ status: 200, data: { status: true, message: 'تمت العملية بنجاح' } });
  configure({ url: 'https://maher.e-statee.com', platform: 'ai_chat', enabled: true, projects: PROJECTS }, 'estate-key');
});

function configure(e, token) {
  db.prepare('UPDATE companies SET settings = ?, estate_token = ? WHERE id = ?').run(JSON.stringify({ estate: e }), token, 'maheer');
  require('../companies').invalidateCache();
}
const company = () => require('../companies').loadCompany('maheer');

let seq = 0;
function callWith(requests, number = '+966501234567') {
  const id = `conv-${++seq}`;
  db.prepare(`INSERT INTO calls (id, company_id, caller_number, duration_sec, transcript, direction, created_at)
              VALUES (?, 'maheer', ?, 60, 'وكيل: هلا', 'inbound', datetime('now'))`).run(id, number);
  for (const [type, fields] of requests) {
    db.prepare(`INSERT INTO customer_requests (company_id, conversation_id, request_type, customer_name, fields)
                VALUES ('maheer', ?, ?, ?, ?)`).run(id, type, fields.customer_name || null, JSON.stringify(fields));
  }
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
}
const requestsOf = (callId) => db.prepare('SELECT * FROM customer_requests WHERE conversation_id = ? ORDER BY id').all(callId);

const PROJECTS = [{ name: 'M-10 — أدوار، حي المغرزات', code: 'M-10' }, { name: 'وكن 038 — فلل، حي النهضة', code: 'W-38' }];
const INTEREST = {
  customer_name: 'أبو فهد', interest_status: 'مهتم جداً', project: 'M-10 — أدوار، حي المغرزات', interest_reasons: 'الموقع', property_type: 'شقة',
  purchase_reason: 'سكن', payment_method: 'تمويل بنكي', referral_source: 'سناب',
};

// ─── after a call ─────────────────────────────────────────────────
test('a purchase-interest request goes to the company\'s Estate after the call, once', async () => {
  const call = callWith([['interest', INTEREST]]);
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ sent: true }]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].origin, 'https://maher.e-statee.com');
  assert.equal(posts[0].token, 'estate-key');
  assert.deepEqual(Object.keys(posts[0].form), ['name', 'phone', 'platform', 'project_codes[0]', 'note']);
  assert.equal(posts[0].form.name, 'أبو فهد');
  assert.equal(posts[0].form.phone, '0501234567');          // the local way, as Estate's example
  assert.equal(posts[0].form.platform, 'ai_chat');
  assert.equal(posts[0].form['project_codes[0]'], 'M-10');
  assert.equal(posts[0].form.note, [
    'طلب اهتمام من مكالمة مع المساعد الذكي',
    'حالة الاهتمام: مهتم جداً', 'المشروع المهتم به: M-10 — أدوار، حي المغرزات', 'أبرز أسباب الاهتمام: الموقع', 'نوع العقار: شقة',
    'سبب الشراء: سكن', 'طريقة الدفع: تمويل بنكي', 'كيف سمعت عنا: سناب',
  ].join('\n'));
  const [row] = requestsOf(call.id);
  assert.equal(row.estate_status, 'sent');
  assert.equal(row.estate_detail, 'تمت العملية بنجاح');
  // The same call's event again: nothing new goes.
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ duplicate: true }]);
  assert.equal(posts.length, 1);
});

test('rental requests are not sent, and say why', async () => {
  const call = callWith([['leasing', { customer_name: 'سارة', unit_area: '120' }], ['leasing_commercial', { customer_name: 'سارة' }]]);
  const out = await estate.afterCall(await company(), call, deps());
  assert.equal(posts.length, 0);
  assert.equal(out.length, 2);
  for (const r of requestsOf(call.id)) {
    assert.equal(r.estate_status, 'skipped');
    assert.match(r.estate_detail, /لطلبات البيع/);
  }
});

test('a request without the customer\'s name is not sent with a made-up one', async () => {
  const call = callWith([['interest', { interest_status: 'مهتم' }]]);
  await estate.afterCall(await company(), call, deps());
  assert.equal(posts.length, 0);
  assert.match(requestsOf(call.id)[0].estate_detail, /بلا اسم عميل/);
});

test('nothing at all goes while it is off, without the key, or to an address that is not Estate', async () => {
  for (const [e, token] of [
    [{ url: 'https://maher.e-statee.com', platform: 'p', enabled: false }, 'k'],
    [{ url: 'https://maher.e-statee.com', platform: 'p', enabled: true }, null],
    [{ url: 'https://evil.example.com', platform: 'p', enabled: true }, 'k'],
  ]) {
    configure(e, token);
    const call = callWith([['interest', INTEREST]]);
    await estate.afterCall(await company(), call, deps());
    assert.equal(requestsOf(call.id)[0].estate_status, null, JSON.stringify(e));
  }
  assert.equal(posts.length, 0);
});

// ─── Estate's answers ─────────────────────────────────────────────
test('a refusal keeps Estate\'s own words; sending again by hand goes once it is fixed', async () => {
  answer = () => ({ status: 422, data: { message: 'The given data was invalid.', errors: { email: ['حقل البريد الإلكتروني مطلوب.'], project_ids: ['حقل المشاريع مطلوب.'] } } });
  const call = callWith([['interest', INTEREST]]);
  const [r] = await estate.afterCall(await company(), call, deps());
  assert.equal(r.failed, 'حقل البريد الإلكتروني مطلوب. — حقل المشاريع مطلوب.');
  assert.equal(requestsOf(call.id)[0].estate_status, 'failed');
  assert.equal(requestsOf(call.id)[0].estate_detail, r.failed);

  // Not again on its own (a replayed event)...
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ duplicate: true }]);
  // ...but by hand, once Estate takes it.
  answer = () => ({ status: 201, data: { status: true, message: 'تمت العملية بنجاح' } });
  const row = sql.getRequestForEstate.get(requestsOf(call.id)[0].id, 'maheer');
  assert.deepEqual(await estate.pushRequest(await company(), row, deps(), { retry: true }), { sent: true });
  // And a sent one is never sent again, even by hand.
  const sentRow = sql.getRequestForEstate.get(row.id, 'maheer');
  assert.deepEqual(await estate.pushRequest(await company(), sentRow, deps(), { retry: true }), { duplicate: true });
  assert.equal(posts.length, 2);                            // the refused one, then the one by hand
});

test('a 2xx that says status: false is a refusal, not a success', async () => {
  answer = () => ({ status: 200, data: { status: false, message: 'رقم الجوال غير صحيح' } });
  const call = callWith([['interest', INTEREST]]);
  const [r] = await estate.afterCall(await company(), call, deps());
  assert.equal(r.failed, 'رقم الجوال غير صحيح');
});

test('a wrong key, a wrong address and an unreachable Estate each say so', async () => {
  for (const [a, re] of [
    [{ status: 401, data: { message: 'Unauthenticated.' } }, /رفض Estate المفتاح/],
    [{ status: 404, data: { message: 'not found' } }, /لا توجد واجهة الطلبات/],
    [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), /تعذّر الوصول إلى Estate: ETIMEDOUT/],
  ]) {
    answer = () => a;
    const call = callWith([['interest', INTEREST]]);
    const [r] = await estate.afterCall(await company(), call, deps());
    assert.match(r.failed, re);
  }
});

// ─── checking, settings, shapes ───────────────────────────────────
test('the check reads Estate\'s answer to a request with no fields', async () => {
  const run = (a, extra = {}) => estate.check({ url: 'https://maher.e-statee.com/api/v1/make/attention-request/attention-request-store', token: 'k', send: async (o, t, f) => { posts.push({ o, f: [...f] }); return a; }, ...extra });
  let r = await run({ status: 422, data: { errors: { name: ['الاسم مطلوب'], phone: ['الجوال مطلوب'] } } });
  assert.equal(r.ok, true);
  assert.match(r.text, /المفتاح مقبول.*الاسم مطلوب — الجوال مطلوب/);
  assert.deepEqual(posts.at(-1).f, []);                    // no fields at all
  assert.equal(posts.at(-1).o, 'https://maher.e-statee.com');
  assert.equal((await run({ status: 401, data: {} })).ok, false);
  assert.match((await run({ status: 404, data: {} })).text, /لا توجد واجهة/);
  r = await run({ status: 200, data: { status: true } });
  assert.equal(r.warn, true);
  assert.match(r.text, /احذفه/);
  assert.match((await estate.check({ url: 'https://example.com', token: 'k' })).text, /غير صالح/);
  assert.match((await estate.check({ url: 'https://maher.e-statee.com', token: null })).text, /لم يُحفظ مفتاح/);
});

test('only an https Estate address is accepted, from the bare host or the full endpoint', () => {
  assert.equal(estate.estateOrigin('https://maher.e-statee.com'), 'https://maher.e-statee.com');
  assert.equal(estate.estateOrigin(' https://Maher.e-statee.com/api/v1/make/attention-request/attention-request-store '), 'https://maher.e-statee.com');
  for (const bad of ['http://maher.e-statee.com', 'https://e-statee.com.evil.com', 'https://maher.e-statee.com:8443', 'https://evil.com/maher.e-statee.com', 'maher.e-statee.com', '']) {
    assert.equal(estate.estateOrigin(bad), null, bad);
  }
});

test('numbers are written the local Saudi way, others internationally', () => {
  assert.equal(estate.estatePhone('+966 50 123 4567'), '0501234567');
  assert.equal(estate.estatePhone('00966501234567'), '0501234567');
  assert.equal(estate.estatePhone('0501234567'), '0501234567');
  assert.equal(estate.estatePhone('501234567'), '0501234567');
  assert.equal(estate.estatePhone('+201095363467'), '+201095363467');
  assert.equal(estate.estatePhone(''), null);
});

test('switching it on needs the address and the key; platform is ai_chat unless set', () => {
  const ok = { url: 'https://maher.e-statee.com', platform: '', enabled: true, projects: '' };
  assert.deepEqual(estate.validateSettings(ok, { hasToken: true }).estate, { url: 'https://maher.e-statee.com', platform: null, enabled: true, projects: [] });
  assert.equal(estate.settingsOf({ settings: { estate: { platform: null } } }).platform, 'ai_chat');
  assert.equal(estate.settingsOf({ settings: { estate: { platform: 'other' } } }).platform, 'other');
  assert.match(estate.validateSettings(ok, { hasToken: false }).error, /المفتاح/);
  assert.match(estate.validateSettings({ ...ok, url: 'https://x.com' }, { hasToken: true }).error, /غير صالح/);
  assert.deepEqual(estate.validateSettings({ url: '', platform: '', enabled: false }, { hasToken: false }).estate, { url: null, platform: null, enabled: false, projects: [] });
});

test('the project list is pasted as lines of "name = code", and checked line by line', () => {
  const text = 'M-10 — أدوار، حي المغرزات = M-10\n\n  وكن 038 — فلل، حي النهضة   =   W-38  \n';
  assert.deepEqual(estate.parseProjects(text).projects, [
    { name: 'M-10 — أدوار، حي المغرزات', code: 'M-10' }, { name: 'وكن 038 — فلل، حي النهضة', code: 'W-38' },
  ]);
  // Saved as a list, read back as one.
  assert.deepEqual(estate.parseProjects(estate.parseProjects(text).projects).projects, estate.parseProjects(text).projects);
  assert.match(estate.parseProjects('M-10').error, /السطر 1/);
  assert.match(estate.parseProjects('أ = M-10\nب = رمز').error, /السطر 2: رمز المشروع «رمز» غير صالح/);
  assert.match(estate.parseProjects('أ = M-10\nأ = M-11').error, /مكرر/);
  assert.match(estate.validateSettings({ url: '', projects: 'x =' }, { hasToken: false }).error, /السطر 1/);
});

test('the code goes only for a project on the list; otherwise the lead goes without one', async () => {
  assert.equal(estate.projectCode('M-10 — أدوار، حي المغرزات', PROJECTS), 'M-10');
  assert.equal(estate.projectCode('  وكن 038 — فلل،  حي النهضة ', PROJECTS), 'W-38');   // spacing
  assert.equal(estate.projectCode('M-10', PROJECTS), 'M-10');                              // its own code
  assert.equal(estate.projectCode('مشروع لا نعرفه', PROJECTS), null);
  assert.equal(estate.projectCode('', PROJECTS), null);
  const call = callWith([['interest', { ...INTEREST, project: 'مشروع لا نعرفه' }]]);
  await estate.afterCall(await company(), call, deps());
  assert.equal(posts.at(-1).form['project_codes[0]'], undefined);
  assert.match(posts.at(-1).form.note, /المشروع المهتم به: مشروع لا نعرفه/);   // still told, in the note
});

test('the key never rides along with the company, and the requests list carries each outcome', () => {
  const { toCompany } = require('../companies');
  const c = toCompany(sql.listCompanies.all().find((r) => r.id === 'maheer'));
  assert.ok(!JSON.stringify(c).includes('estate-key'));
  const row = sql.listCustomerRequests.all('maheer').find((r) => r.estate_status === 'sent');
  assert.ok(row && 'estate_detail' in row && 'estate_at' in row);
});
