const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { sql } = require('../db');

// __Host- prefix in production locks the cookie to (a) the exact origin (no Domain),
// (b) Path=/, and (c) Secure. The plain `sid` is used in dev where Secure is off.
const COOKIE_SECURE  = process.env.COOKIE_SECURE === 'true';
const COOKIE_NAME    = COOKIE_SECURE ? '__Host-sid' : 'sid';
const SESSION_DAYS   = 30;
const BCRYPT_COST    = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// The raw token lives only in the user's cookie. We store its SHA-256 hash
// as the row key in `sessions`, so a DB leak doesn't yield usable cookies.
function newRawToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function createSession(userId, req) {
  const raw = newRawToken();
  const dbId = hashToken(raw);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await sql.insertSession.run({
    id        : dbId,
    user_id   : userId,
    expires_at: expiresAt,
    user_agent: (req.get('user-agent') || '').slice(0, 255),
    ip        : req.ip || req.socket?.remoteAddress || null,
  });
  return { id: raw, expiresAt };                              // raw goes to cookie
}

async function sessionFromCookie(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const dbId = hashToken(raw);
  const row = await sql.getSessionById.get(dbId);
  if (!row) return null;
  // Reject sessions whose owning user got locked AFTER the session was created.
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    await sql.deleteSession.run(dbId);
    return null;
  }
  // Rolling expiry: each authenticated request extends the lifetime.
  const newExpires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await sql.touchAndExtendSession.run(newExpires, dbId);
  return {
    sessionId: dbId,                                          // hashed form, safe to log/use server-side
    user: { id: row.uid, email: row.email, name: row.user_name, role: row.role, companyId: row.company_id },
  };
}

function setSessionCookie(res, sessionId) {
  const secure = process.env.COOKIE_SECURE === 'true';
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path    : '/',
    maxAge  : SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  const secure = process.env.COOKIE_SECURE === 'true';
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path    : '/',
  });
}

async function destroySession(sessionId) {
  if (sessionId) await sql.deleteSession.run(sessionId);
}

async function logEvent(eventType, req, { userId = null, email = null } = {}) {
  await sql.logAuthEvent.run({
    user_id   : userId,
    email     : email || null,
    event_type: eventType,
    ip        : req.ip || req.socket?.remoteAddress || null,
    user_agent: (req.get('user-agent') || '').slice(0, 255),
  });
}

async function requireAuth(req, res, next) {
  try {
    const ctx = await sessionFromCookie(req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    req.user = ctx.user;
    req.sessionId = ctx.sessionId;
    next();
  } catch (e) { next(e); }
}

function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// Verify the authenticated user may operate on the company referenced by :id.
// Superadmins manage everything; workspace clients can read/operate only on
// their own company. Existence is hidden for outsiders (404 rather than 403).
async function requireCompanyAccess(req, res, next) {
  try {
    const companyId = req.params.id || req.params.companyId;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const row = await sql.companyExists.get(companyId);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (req.user.role === 'superadmin') return next();
    if (req.user.role === 'client' && req.user.companyId === companyId) return next();
    return res.status(404).json({ error: 'not found' });
  } catch (e) { next(e); }
}

// Same as above but stricter — write operations (delete, sync-vapi,
// bind-phone, company-level mutations) stay superadmin-only even when a
// client can read the company's data.
async function requireCompanyAdmin(req, res, next) {
  try {
    const companyId = req.params.id || req.params.companyId;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    if (req.user.role !== 'superadmin') return res.status(404).json({ error: 'not found' });
    const row = await sql.companyExists.get(companyId);
    if (!row) return res.status(404).json({ error: 'not found' });
    next();
  } catch (e) { next(e); }
}

// True when the user may chat with the given company.
// - superadmin: any company (testing)
// - client: only the company they belong to
function canChatWithCompany(user, companyId) {
  if (!user || !companyId) return false;
  if (user.role === 'superadmin') return true;
  if (user.role === 'client') return user.companyId === companyId;
  return false;
}

// Periodic cleanup of expired sessions (best-effort, driver-agnostic).
function startSessionCleanup() {
  const purge = () => Promise.resolve(sql.purgeExpired.run()).catch(() => {});
  purge();
  setInterval(purge, 60 * 60 * 1000).unref();
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  sessionFromCookie,
  setSessionCookie,
  clearSessionCookie,
  logEvent,
  requireAuth,
  requireSuperadmin,
  requireCompanyAccess,
  requireCompanyAdmin,
  canChatWithCompany,
  startSessionCleanup,
};
