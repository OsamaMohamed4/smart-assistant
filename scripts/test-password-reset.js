// Password-reset and sign-in links: one use, a time limit, only the newest
// link works, and a cap on how many go to one account in an hour.
//
// Real statements on a throwaway SQLite DB — no network.
//
//   node --test scripts/test-password-reset.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-reset-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;

const { db } = require('../db');
const resets = require('../lib/password-reset');

let uid;
before(() => {
  uid = Number(db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('owner@maheer.sa', 'x', 'العنود', 'superadmin')").run().lastInsertRowid);
});
after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

test('a link works once', async () => {
  const token = await resets.issueToken(uid, 'reset', '1.2.3.4');
  assert.ok(token.length >= 40);
  const row = await resets.findValid(token);
  assert.equal(row.user_id, uid);
  assert.equal(row.email, 'owner@maheer.sa');
  const first = await resets.consumeToken(token);
  assert.equal(first.row.user_id, uid);
  const second = await resets.consumeToken(token);
  assert.match(second.error, /غير صالح|استُخدم/);
});

test('only a hash of the token is stored', async () => {
  const token = await resets.issueToken(uid);
  const stored = db.prepare('SELECT token_hash FROM password_resets ORDER BY id DESC LIMIT 1').get().token_hash;
  assert.notEqual(stored, token);
  assert.equal(stored, resets.hashToken(token));
});

test('a new link retires the earlier ones', async () => {
  const older = await resets.issueToken(uid);
  const newer = await resets.issueToken(uid);
  assert.equal(await resets.findValid(older), null);
  assert.ok(await resets.findValid(newer));
});

test('an expired link is refused', async () => {
  const token = await resets.issueToken(uid);
  db.prepare("UPDATE password_resets SET expires_at = '2020-01-01 00:00:00' WHERE token_hash = ?").run(resets.hashToken(token));
  assert.equal(await resets.findValid(token), null);
  assert.match((await resets.consumeToken(token)).error, /انتهت صلاحيته/);
});

test('a reset link lasts an hour; a sign-in link sent by an operator, three days', async () => {
  const check = async (purpose, hours) => {
    const t = await resets.issueToken(uid, purpose);
    const row = db.prepare('SELECT expires_at, created_at FROM password_resets WHERE token_hash = ?').get(resets.hashToken(t));
    const span = (Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) - Date.now()) / 3600000;
    assert.ok(Math.abs(span - hours) < 0.05, `${purpose}: ${span}h`);
  };
  await check('reset', 1);
  await check('invite', 72);
});

test('garbage never matches', async () => {
  for (const bad of ['', 'x', 'a'.repeat(500), null, undefined]) assert.equal(await resets.findValid(bad), null);
});

test('no more than three reset e-mails an hour for one account', async () => {
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(uid);
  for (let i = 0; i < resets.MAX_PER_HOUR; i++) {
    assert.equal(await resets.tooManyRecent(uid), false);
    await resets.issueToken(uid);
  }
  assert.equal(await resets.tooManyRecent(uid), true);
});

test('the address is shown masked, enough to recognise it', () => {
  assert.equal(resets.maskEmail('owner@maheer.sa'), 'o***r@maheer.sa');
  assert.equal(resets.maskEmail('ab@x.sa'), 'a*b@x.sa');
  assert.equal(resets.maskEmail('nope'), '');
});

test('the e-mail is Arabic, carries the link, and says how long it lasts', () => {
  const r = resets.linkEmail({ link: 'https://www.getmasar.sa/reset-password?token=abc', name: 'العنود', purpose: 'reset' });
  assert.match(r.subject, /إعادة تعيين كلمة المرور/);
  assert.match(r.html, /https:\/\/www\.getmasar\.sa\/reset-password\?token=abc/);
  assert.match(r.text, /ساعة/);
  assert.match(r.text, /تجاهل/);
  const invite = resets.linkEmail({ link: 'https://x/reset-password?token=z', purpose: 'invite', companyName: 'مهير العقارية' });
  assert.match(invite.text, /72 ساعة/);
  assert.match(invite.text, /مهير العقارية/);
  // Plain Arabic, no Egyptian forms.
  for (const word of ['مش', 'ده', 'عشان', 'إزاي', 'دلوقتي']) {
    assert.doesNotMatch(r.text + invite.text, new RegExp(`(^|\\s)${word}(\\s|$)`));
  }
});
