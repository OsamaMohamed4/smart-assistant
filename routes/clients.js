const express = require('express');
const crypto = require('crypto');
const { sql } = require('../db');
const { requireAuth, requireCompanyAccess, hashPassword } = require('../lib/auth');

const router = express.Router({ mergeParams: true });

router.use(requireAuth, requireCompanyAccess);

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

// GET /api/companies/:id/clients
router.get('/', (req, res) => {
  res.json(sql.listClientsForCompany.all(req.params.id));
});

// Tighter than the loose `[^@\s]+@...` from before.
const EMAIL_RE_STRICT = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;

// POST /api/companies/:id/clients  body: { email, name }
router.post('/', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name  = String(req.body?.name || '').trim().slice(0, 80) || null;
  if (!EMAIL_RE_STRICT.test(email)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح' });
  if (sql.getUserByEmail.get(email)) {
    return res.status(409).json({ error: 'الإيميل ده مسجّل بالفعل' });
  }

  const password = generatePassword();
  const password_hash = await hashPassword(password);

  const insert = sql.insertUser.run({
    email,
    password_hash,
    name,
    role      : 'client',
    company_id: req.params.id,
  });

  try {
    sql.logAuditEvent.run({
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

// DELETE /api/companies/:id/clients/:userId
router.delete('/:userId', (req, res) => {
  const uid = Number(req.params.userId);
  if (!uid) return res.status(400).json({ error: 'invalid id' });
  // Confirm the user is actually a client of this company before deleting.
  const u = sql.getUserById.get(uid);
  if (!u || u.role !== 'client' || u.company_id !== req.params.id) {
    return res.status(404).json({ error: 'client not found' });
  }
  // Belt-and-suspenders: this route should never delete a superadmin even if
  // the role check above somehow flipped; protect against accidental escalation.
  if (u.role === 'superadmin' || (sql.countSuperadmins.get().n <= 1 && u.id === req.user.id)) {
    return res.status(403).json({ error: 'لا يمكن حذف هذا الحساب' });
  }
  sql.deleteUser.run(uid);
  try {
    sql.logAuditEvent.run({
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
