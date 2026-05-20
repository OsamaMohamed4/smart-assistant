const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { db, sql } = require('../db');
const {
  hashPassword, verifyPassword,
  createSession, destroySession,
  sessionFromCookie, setSessionCookie, clearSessionCookie,
  logEvent, requireAuth,
} = require('../lib/auth');

const router = express.Router();

// RFC-friendly enough for ops use. Tighter than the original ([^@\s]+@[^@\s]+).
// Requires: local part 1..64 chars, domain has a dot, TLD 2..24 letters.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;
const MIN_PASSWORD = 8;

function isStrongPassword(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) return false;
  return /[A-Za-z]/.test(p) && /\d/.test(p);
}

// Pre-computed hash used as a constant-time decoy when login is attempted with
// an email that doesn't exist — equalises latency to defeat user enumeration.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-only', 12);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message : { error: 'too many requests, slow down' },
});

// Tighter limiter for the bootstrap probe: this endpoint reveals whether the
// platform is freshly installed (and thus the first signup is unauthenticated).
// We expose it only sparingly to discourage scanning for fresh installs.
const bootstrapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : 3,
  standardHeaders: true,
  legacyHeaders  : false,
  message : { error: 'too many requests' },
});

router.use(authLimiter);

// Signup is bootstrap-only. Once the first superadmin exists, all new accounts
// must be created by the superadmin (clients via owner panel).
router.post('/signup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim().slice(0, 80) || null;

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح' });
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: `كلمة السر لازم تكون ${MIN_PASSWORD}+ أحرف وتحتوي على حرف ورقم` });
  }

  // Hash outside the transaction so we don't hold the DB lock during bcrypt.
  const password_hash = await hashPassword(password);

  // Atomically: re-check "DB empty" and insert. Two concurrent bootstrap
  // attempts can no longer both win — only the first transaction commits.
  let userId;
  try {
    const tx = db.transaction(() => {
      if (sql.countUsers.get().n !== 0) throw new Error('BOOTSTRAP_CLOSED');
      if (sql.getUserByEmail.get(email)) throw new Error('EMAIL_TAKEN');
      const insert = sql.insertUser.run({
        email, password_hash, name, role: 'superadmin', company_id: null,
      });
      sql.claimOrphanCompanies.run(insert.lastInsertRowid);
      return insert.lastInsertRowid;
    });
    userId = tx();
  } catch (e) {
    if (e.message === 'BOOTSTRAP_CLOSED') {
      return res.status(403).json({ error: 'التسجيل مغلق. تواصل مع المسؤول للحصول على حساب.' });
    }
    if (e.message === 'EMAIL_TAKEN') {
      return res.status(409).json({ error: 'الإيميل ده مسجّل بالفعل' });
    }
    throw e;
  }

  const session = createSession(userId, req);
  setSessionCookie(res, session.id);
  logEvent('signup', req, { userId, email });

  res.status(201).json({
    user: { id: userId, email, name, role: 'superadmin', companyId: null },
  });
});

// Probe endpoint: tells the frontend whether bootstrap signup is still open.
// Rate-limited to 3/min/IP so it can't be abused as a fresh-install scanner.
// Also returns `{open:false}` for ALL requests once the platform has even one
// user, so attackers can't distinguish a real platform from an empty one.
router.get('/bootstrap', bootstrapLimiter, (_req, res) => {
  res.json({ open: sql.countUsers.get().n === 0 });
});

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'البريد وكلمة السر مطلوبين' });

  const user = sql.getUserByEmail.get(email);
  // Always run bcrypt — on unknown emails against DUMMY_HASH — so the response
  // time doesn't reveal whether the email is registered. Failure messages stay
  // identical for "no such user" and "wrong password".
  const hashToCheck = user?.password_hash || DUMMY_HASH;
  const ok = await bcrypt.compare(password, hashToCheck);

  if (!user) {
    logEvent('login_fail', req, { email });
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    logEvent('login_fail', req, { userId: user.id, email });
    return res.status(429).json({ error: 'الحساب مقفول مؤقتاً بسبب محاولات فاشلة. حاول بعد 15 دقيقة' });
  }

  if (!ok) {
    sql.bumpFailedLogin.run(user.id);
    logEvent('login_fail', req, { userId: user.id, email });
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  sql.clearFailedLogins.run(user.id);
  const session = createSession(user.id, req);
  setSessionCookie(res, session.id);
  logEvent('login_ok', req, { userId: user.id, email });

  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.company_id },
  });
});

router.post('/logout', (req, res) => {
  const ctx = sessionFromCookie(req);
  if (ctx) {
    destroySession(ctx.sessionId);
    logEvent('logout', req, { userId: ctx.user.id, email: ctx.user.email });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const oldPw = String(req.body?.oldPassword || '');
  const newPw = String(req.body?.newPassword || '');
  if (!isStrongPassword(newPw)) {
    return res.status(400).json({ error: `كلمة السر الجديدة لازم تكون ${MIN_PASSWORD}+ أحرف وتحتوي على حرف ورقم` });
  }
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const ok = await verifyPassword(oldPw, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'كلمة السر القديمة غير صحيحة' });

  const newHash = await hashPassword(newPw);
  sql.updatePassword.run(newHash, req.user.id);
  sql.deleteUserSessions.run(req.user.id);

  const session = createSession(req.user.id, req);
  setSessionCookie(res, session.id);
  res.json({ ok: true });
});

module.exports = router;
