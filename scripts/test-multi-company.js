// One client account working in several companies: which company a session
// is in, and that a grant taken away stops working on the very next request.
//
// Runs the real statements against a throwaway SQLite DB -- no network.
//
//   node --test scripts/test-multi-company.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-multico-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;

const { sql, db } = require('../db');
const { companiesFor } = require('../lib/auth');

const SESSION = 'sess-1';
let uid;
before(() => {
  for (const [id, name] of [['masar', 'مسار'], ['wakan', 'وكن'], ['maheer', 'مهير'], ['other', 'شركة أخرى']]) {
    db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES (?, ?, 'ar', '')").run(id, name);
  }
  uid = Number(db.prepare("INSERT INTO users (email, password_hash, name, role, company_id) VALUES ('owner@group.sa', 'x', 'العنود', 'client', 'masar')").run().lastInsertRowid);
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(SESSION, uid);
});
after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

const sessionCompany = () => sql.getSessionById.get(SESSION).company_id;

test('a session works in the home company until it switches', () => {
  assert.equal(sessionCompany(), 'masar');
  assert.equal(sql.getSessionById.get(SESSION).home_company_id, 'masar');
});

test('the companies an account may work in: home first, then its grants', async () => {
  assert.deepEqual(await companiesFor({ id: uid, role: 'client' }), [{ id: 'masar', name: 'مسار' }]);
  sql.insertUserCompany.run({ user_id: uid, company_id: 'wakan', created_by: 'su' });
  sql.insertUserCompany.run({ user_id: uid, company_id: 'maheer', created_by: 'su' });
  sql.insertUserCompany.run({ user_id: uid, company_id: 'maheer', created_by: 'su' }); // granting twice is harmless
  const list = await companiesFor({ id: uid, role: 'client' });
  assert.equal(list[0].id, 'masar');
  assert.deepEqual(list.map((c) => c.id).sort(), ['maheer', 'masar', 'wakan']);
  // A superadmin has nothing to switch between.
  assert.deepEqual(await companiesFor({ id: uid, role: 'superadmin' }), []);
});

test('a session switched to a granted company works there', () => {
  sql.setSessionCompany.run('wakan', SESSION);
  assert.equal(sessionCompany(), 'wakan');
});

test('a company that was never granted is never the session company', () => {
  // Written straight into the row, as a tampered or stale session would be.
  sql.setSessionCompany.run('other', SESSION);
  assert.equal(sessionCompany(), 'masar');
});

test('taking a grant away moves a session working there back home at once', () => {
  sql.setSessionCompany.run('maheer', SESSION);
  assert.equal(sessionCompany(), 'maheer');
  sql.deleteUserCompany.run(uid, 'maheer');
  assert.equal(sessionCompany(), 'masar');
  assert.deepEqual(sql.listGrantedCompanies.all(uid).map((c) => c.id), ['wakan']);
});

test('deleting a company deletes the grants to it', () => {
  sql.insertUserCompany.run({ user_id: uid, company_id: 'other', created_by: 'su' });
  db.prepare("DELETE FROM companies WHERE id = 'other'").run();
  assert.deepEqual(sql.listGrantedCompanies.all(uid).map((c) => c.id), ['wakan']);
});
