// Leads from the public marketing site — "register interest" (contact) and
// job applications ("join us"). They land in the `site_leads` table and are
// read only in the dashboard, by a superadmin.
//
// Two routers are exported:
//   publicRouter — mounted BEFORE the /api auth gate, so the public site can
//                  post to it with no login. It is still behind the global
//                  CSRF gate (requireXhrHeader), so the site's forms submit
//                  with `X-Requested-With: XMLHttpRequest`, and behind a tight
//                  rate limit so it cannot be used to flood the table.
//   adminRouter  — mounted AFTER the auth gate with requireSuperadmin, so only
//                  the platform admin can list, download a CV, mark read, or
//                  delete. Client accounts never see these.
//
// Storage: a CV, when attached, is kept in the row as bytes (cv_data), the
// same way kb_documents keeps its files — the deployment has no object store
// for user uploads. Queries use the driver-agnostic get/all/run helpers with
// '?' placeholders, so nothing here needs a named statement in the catalog.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { get, all, run } = require('../db');

// ─── validation helpers ───────────────────────────────────────────
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;
const clean = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
};

// Tight limiter: a public form, so a handful a minute per IP is plenty and
// anything above that is abuse. Keyed per IP (the default).
const leadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : 6,
  standardHeaders: true,
  legacyHeaders  : false,
  message : { error: 'عدد كبير من الطلبات، حاول بعد قليل.' },
});

// CV upload: in memory, one file, 5MB, PDF / Word only.
const CV_SIZE_MB = 5;
const CV_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const CV_EXTS = new Set(['pdf', 'doc', 'docx']);
const uploadCv = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: CV_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = String(file.originalname || '').toLowerCase().split('.').pop();
    if (!CV_MIMES.has(file.mimetype) && !CV_EXTS.has(ext)) {
      return cb(Object.assign(new Error('صيغة السيرة الذاتية غير مدعومة — أرفق PDF أو Word.'), { status: 400 }));
    }
    cb(null, true);
  },
});
function cvUpload(req, res, next) {
  uploadCv.single('cv')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `حجم السيرة الذاتية أكبر من ${CV_SIZE_MB} ميجابايت.`
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'أرفق ملفاً واحداً.'
      : err.status === 400 ? err.message
      : null;
    if (!msg) return next(err);
    res.status(400).json({ error: msg });
  });
}

async function insertLead(kind, b, file, req) {
  await run(
    `INSERT INTO site_leads
       (kind, name, email, phone, company, sector, monthly_calls, message,
        cv_filename, cv_mime, cv_size, cv_data, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      kind,
      clean(b.name, 120),
      clean(b.email, 160),
      clean(b.phone, 32),
      clean(b.company, 160),
      clean(b.sector, 80),
      clean(b.monthly_calls, 60),
      clean(b.message, 4000),
      file ? clean(file.originalname, 200) : null,
      file ? clean(file.mimetype, 100) : null,
      file ? file.size : null,
      file ? file.buffer : null,
      req.ip || null,
      (req.get('user-agent') || '').slice(0, 255) || null,
    ],
  );
}

// ══ Public ════════════════════════════════════════════════════════
const publicRouter = express.Router();

// POST /api/public/lead — "register interest" (contact) form.
publicRouter.post('/lead', leadLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const name  = clean(b.name, 120);
    const email = clean(b.email, 160);
    const phone = clean(b.phone, 32);
    if (!name)            return res.status(400).json({ error: 'الاسم مطلوب.' });
    if (!email && !phone) return res.status(400).json({ error: 'أدخل بريدًا إلكترونيًا أو رقم جوال للتواصل.' });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح.' });
    await insertLead('contact', b, null, req);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/public/apply — "join us" application, with an optional CV file.
// multipart/form-data: text fields + an optional `cv` file.
publicRouter.post('/apply', leadLimiter, cvUpload, async (req, res, next) => {
  try {
    const b = req.body || {};
    const name  = clean(b.name, 120);
    const email = clean(b.email, 160);
    const phone = clean(b.phone, 32);
    if (!name)            return res.status(400).json({ error: 'الاسم مطلوب.' });
    if (!email && !phone) return res.status(400).json({ error: 'أدخل بريدًا إلكترونيًا أو رقم جوال للتواصل.' });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح.' });
    await insertLead('join', b, req.file || null, req);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// ══ Admin (superadmin only; mounted after the auth gate) ═══════════
const adminRouter = express.Router();

// GET /api/site-leads?kind=contact|join&page=1&limit=25 — list without the CV
// bytes (only whether one exists), newest first.
adminRouter.get('/', async (req, res, next) => {
  try {
    const kind = ['contact', 'join'].includes(req.query.kind) ? req.query.kind : null;
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const whereKind = kind ? 'WHERE kind = ?' : '';
    const kindParams = kind ? [kind] : [];
    const total = Number((await get(`SELECT COUNT(*) AS n FROM site_leads ${whereKind}`, kindParams)).n) || 0;
    const items = await all(
      `SELECT id, kind, name, email, phone, company, sector, monthly_calls, message,
              cv_filename, cv_mime, cv_size, status, created_at,
              (cv_data IS NOT NULL) AS has_cv
         FROM site_leads
         ${whereKind}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...kindParams, limit, offset],
    );
    // has_cv comes back 1/0 (sqlite) or true/false (pg) — normalise to boolean.
    for (const it of items) it.has_cv = !!it.has_cv && it.has_cv !== '0';
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

// GET /api/site-leads/:id/cv — download the attached CV.
adminRouter.get('/:id/cv', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const row = await get(`SELECT cv_filename, cv_mime, cv_data FROM site_leads WHERE id = ?`, [id]);
    if (!row || !row.cv_data) return res.status(404).json({ error: 'no cv' });
    const buf = Buffer.isBuffer(row.cv_data) ? row.cv_data : Buffer.from(row.cv_data);
    res.setHeader('Content-Type', row.cv_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(row.cv_filename || 'cv')}`);
    res.send(buf);
  } catch (e) { next(e); }
});

// PATCH /api/site-leads/:id  body: { status: 'new'|'read'|'archived' }
adminRouter.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const status = ['new', 'read', 'archived'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'invalid status' });
    await run(`UPDATE site_leads SET status = ? WHERE id = ?`, [status, id]);
    res.json({ id, status });
  } catch (e) { next(e); }
});

// DELETE /api/site-leads/:id
adminRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    await run(`DELETE FROM site_leads WHERE id = ?`, [id]);
    res.json({ deleted: 1 });
  } catch (e) { next(e); }
});

module.exports = { publicRouter, adminRouter };
