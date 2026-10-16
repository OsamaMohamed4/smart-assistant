const express = require('express');
const crypto = require('crypto');
const { sql } = require('../db');
const { requireAuth, requireCompanyAdmin, hashPassword } = require('../lib/auth');

const router = express.Router({ mergeParams: true });

// Adding / removing workspace clients stays superadmin-only — a client
// can't grant access to themselves or others into their own company.
router.use(requireAuth, requireCompanyAdmin);

// Generate a friendly 12-char password: 3 groups of 4, alphanumeric.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';      // no 0/O/1/I
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    groups.push(s);
  }
  return groups.join('-');
}

// GET /api/companies/:id/clients — each with the OTHER companies it may also
// work in (user_companies), so the grant is visible where it is managed.
router.get('/', async (req, res) => {
  const clients = await sql.listClientsForCompany.all(req.params.id);
  for (const c of clients) c.extraCompanies = await sql.listGrantedCompanies.all(c.id);
  res.json(clients);
});

// PUT /api/companies/:id/clients/:userId/companies  body: { companyIds: [...] }
//
// Grant a client of THIS company access to other companies too — one account
// for a group that owns several. Replaces the whole list, so removing a
// company from it revokes that access; a session working in a revoked
// company falls back to the home company on its next request. Superadmin
// only (router-level requireCompanyAdmin): a client can never widen its own
// reach.
router.put('/:userId/companies', async (req, res) => {
  const uid = Number(req.params.userId);
  if (!uid) return res.status(400).json({ error: 'invalid id' });
  const u = await sql.getUserById.get(uid);
  if (!u || u.role !== 'client' || u.company_id !== req.params.id) {
    return res.status(404).json({ error: 'client not found' });
  }
  const raw = Array.isArray(req.body?.companyIds) ? req.body.companyIds : null;
  if (!raw) return res.status(400).json({ error: 'companyIds must be a list' });
  const wanted = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
    .filter((id) => id !== u.company_id);                    // the home company is implicit
  for (const id of wanted) {
    if (!(await sql.companyExists.get(id))) return res.status(400).json({ error: `شركة غير موجودة: ${id}` });
  }
  // Applied as a difference — revoke what was removed, grant what was added —
  // rather than delete-all-then-insert, so a request landing mid-update never
  // sees the account with no grants at all (statements are not transactional
  // across calls on Postgres).
  const before = (await sql.listGrantedCompanies.all(uid)).map((c) => c.id);
  for (const id of before.filter((x) => !wanted.includes(x))) await sql.deleteUserCompany.run(uid, id);
  for (const id of wanted.filter((x) => !before.includes(x))) {
    await sql.insertUserCompany.run({ user_id: uid, company_id: id, created_by: req.user?.email || null });
  }
  try {
    await sql.logAuditEvent.run({
      actor_id   : req.user?.id || null,
      actor_email: req.user?.email || null,
      action     : 'client.companies',
      resource   : `companies/${req.params.id}/clients/${uid}`,
      metadata   : JSON.stringify({ email: u.email, before, after: wanted }),
      ip         : req.ip || null,
      user_agent : (req.get('user-agent') || '').slice(0, 255),
    });
  } catch {}
  res.json({ id: uid, extraCompanies: await sql.listGrantedCompanies.all(uid) });
});

// Tighter than the loose `[^@\s]+@...` from before.
const EMAIL_RE_STRICT = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;

// POST /api/companies/:id/clients  body: { email, name }
router.post('/', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name  = String(req.body?.name || '').trim().slice(0, 80) || null;
  if (!EMAIL_RE_STRICT.test(email)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح' });
  if (await sql.getUserByEmail.get(email)) {
    return res.status(409).json({ error: 'هذا البريد الإلكتروني مسجّل بالفعل' });
  }

  const password = generatePassword();
  const password_hash = await hashPassword(password);

  const insert = await sql.insertUser.run({
    email,
    password_hash,
    name,
    role      : 'client',
    company_id: req.params.id,
  });

  try {
    await sql.logAuditEvent.run({
      actor_id   : req.user?.id || null,
      actor_email: req.user?.email || null,
      action     : 'client.create',
      resource   : `companies/${req.params.id}/clients/${insert.lastInsertRowid}`,
      metadata   : JSON.stringify({ email }),
      ip         : req.ip || null,
      user_agent : (req.get('user-agent') || '').slice(0, 255),
    });
  } catch {}

  res.status(201).json({
    id        : insert.lastInsertRowid,
    email,
    name,
    password,                                                // shown once, then lost
  });
});

// POST /api/companies/:id/clients/:userId/reset-password
//
// Until this existed, a client who forgot their password had to be DELETED and
// recreated — which threw away their audit trail and their account id along
// with the password. /api/auth/change-password only helps someone who still
// knows the old one.
//
// Self-service reset by email would be better, and is deliberately not what
// this is: the platform has no mail transport, and adding one is a separate
// decision with its own credentials and deliverability concerns. This covers
// the actual failure — a locked-out client and an operator who can help them
// in ten seconds.
router.post('/:userId/reset-password', async (req, res) => {
  const uid = Number(req.params.userId);
  if (!uid) return res.status(400).json({ error: 'invalid id' });

  // The user must really be a client of THIS company. Without this check the
  // :id in the path would be decoration and any company's admin could reset
  // any account, superadmins included.
  const u = await sql.getUserById.get(uid);
  if (!u || u.role !== 'client' || u.company_id !== req.params.id) {
    return res.status(404).json({ error: 'client not found' });
  }

  const password = generatePassword();
  await sql.updatePassword.run(await hashPassword(password), uid);
  // A reset is also the remedy for a lockout, so lift it. Not
  // clearFailedLogins: that stamps last_login_at, and nobody has logged in.
  await sql.unlockUser.run(uid);
  // Every existing session dies. A reset is what an operator reaches for when
  // an account may be compromised, and leaving the old cookies working would
  // make it theatre — the intruder keeps the access, the owner gets a new
  // password. It also logs the client out everywhere, which is what the new
  // password implies.
  await sql.deleteUserSessions.run(uid);

  try {
    await sql.logAuditEvent.run({
      actor_id   : req.user?.id || null,
      actor_email: req.user?.email || null,
      action     : 'client.reset_password',
      resource   : `companies/${req.params.id}/clients/${uid}`,
      metadata   : JSON.stringify({ email: u.email }),   // never the password
      ip         : req.ip || null,
      user_agent : (req.get('user-agent') || '').slice(0, 255),
    });
  } catch {}

  res.json({ id: uid, email: u.email, password });           // shown once, then lost
});

// DELETE /api/companies/:id/clients/:userId
router.delete('/:userId', async (req, res) => {
  const uid = Number(req.params.userId);
  if (!uid) return res.status(400).json({ error: 'invalid id' });
  // Confirm the user is actually a client of this company before deleting.
  const u = await sql.getUserById.get(uid);
  if (!u || u.role !== 'client' || u.company_id !== req.params.id) {
    return res.status(404).json({ error: 'client not found' });
  }
  // Belt-and-suspenders: this route should never delete a superadmin even if
  // the role check above somehow flipped; protect against accidental escalation.
  if (u.role === 'superadmin' || ((await sql.countSuperadmins.get()).n <= 1 && u.id === req.user.id)) {
    return res.status(403).json({ error: 'لا يمكن حذف هذا الحساب' });
  }
  await sql.deleteUser.run(uid);
  try {
    await sql.logAuditEvent.run({
      actor_id   : req.user?.id || null,
      actor_email: req.user?.email || null,
      action     : 'client.delete',
      resource   : `companies/${req.params.id}/clients/${uid}`,
      metadata   : JSON.stringify({ email: u.email }),
      ip         : req.ip || null,
      user_agent : (req.get('user-agent') || '').slice(0, 255),
    });
  } catch {}
  res.json({ deleted: 1 });
});

module.exports = router;
