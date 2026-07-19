// Outbound campaign management. Mounted at /api/companies/:id/campaigns
// (mergeParams) behind requireAuth + requireCompanyAccess, so every route is
// tenant-scoped; sub-resources re-verify the campaign belongs to :id.
const express = require('express');
const { sql, withTransaction } = require('../db');
const { encryptField, decryptRows, CONTACT_PII_FIELDS } = require('../lib/pii');
const { requireCompanyAccess } = require('../lib/auth');
const { audit } = require('../lib/audit');
const { validate } = require('../lib/validate');
const { campaignCreateBody } = require('../lib/schemas');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAccess);

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_CONTACTS = 5000;

async function loadOwnedCampaign(req, res) {
  const campaign = await sql.getCampaign.get(Number(req.params.campaignId));
  if (!campaign || campaign.company_id !== req.params.id) {
    res.status(404).json({ error: 'campaign not found' });
    return null;
  }
  return campaign;
}

// Returns { contacts, rejected, duplicates }. Invalid numbers used to be
// dropped silently, so an operator pasting 500 rows in the wrong format got a
// campaign with fewer contacts and no explanation. We now report them back.
function parseContacts(body) {
  const out = [];
  const rejected = [];
  const push = (rawPhone, name, variables) => {
    const original = String(rawPhone || '').trim();
    let phone = original.replace(/[\s-]/g, '');
    // Tolerate the common Saudi paste formats: 05xxxxxxxx / 9665xxxxxxxx.
    if (/^05\d{8}$/.test(phone)) phone = '+966' + phone.slice(1);
    if (/^9665\d{8}$/.test(phone)) phone = '+' + phone;
    if (!E164.test(phone)) {
      if (original) rejected.push(original.slice(0, 40));
      return;
    }
    out.push({ phone, name: String(name || '').trim().slice(0, 80) || null, variables: variables || null });
  };
  if (Array.isArray(body.contacts)) {
    for (const c of body.contacts) {
      if (!c) continue;
      const { phone, name, ...vars } = typeof c === 'object' ? c : { phone: c };
      push(phone, name, Object.keys(vars).length ? JSON.stringify(vars) : null);
    }
  }
  if (typeof body.numbersText === 'string') {
    // One contact per line: "phone" or "phone,name"
    for (const line of body.numbersText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [phone, name] = line.split(',');
      if (phone?.trim()) push(phone, name);
    }
  }
  // Dedupe by phone, keep first occurrence.
  const seen = new Set();
  let duplicates = 0;
  const contacts = out.filter((c) => {
    if (seen.has(c.phone)) { duplicates++; return false; }
    seen.add(c.phone);
    return true;
  });
  return { contacts, rejected, duplicates };
}

// Create a campaign with its contact list (draft — start explicitly).
router.post('/', validate({ body: campaignCreateBody }), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'اسم الحملة مطلوب' });
  const { contacts, rejected, duplicates } = parseContacts(b);
  if (!contacts.length) {
    return res.status(400).json({
      error: 'لا توجد أرقام صالحة (الصيغة: ‎+9665xxxxxxxx أو 05xxxxxxxx)',
      rejectedSample: rejected.slice(0, 10),
      rejectedCount : rejected.length,
    });
  }
  if (contacts.length > MAX_CONTACTS) return res.status(400).json({ error: `الحد الأقصى ${MAX_CONTACTS} رقم لكل حملة` });

  const clampInt = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : dflt);

  // Campaign + all contacts in ONE transaction. Previously the contacts were
  // inserted one-by-one outside any transaction: on Postgres that is a round
  // trip per row (minutes for a 5k list) and a crash mid-loop left a
  // half-imported campaign that would start dialling an incomplete list.
  let campaignId;
  await withTransaction(async () => {
    const insert = await sql.insertCampaign.run({
      company_id     : req.params.id,
      name,
      start_hour     : clampInt(b.startHour, 0, 23, 10),
      end_hour       : clampInt(b.endHour, 0, 23, 21),
      max_concurrent : clampInt(b.maxConcurrent, 1, 10, 2),
      max_attempts   : clampInt(b.maxAttempts, 1, 5, 2),
      retry_delay_min: clampInt(b.retryDelayMin, 5, 24 * 60, 60),
    });
    campaignId = Number(insert.lastInsertRowid);
    for (const c of contacts) {
      await sql.insertCampaignContact.run({
        campaign_id: campaignId,
        company_id : req.params.id,   // denormalized so RLS covers this table
        phone      : encryptField(c.phone),
        name       : c.name,
        variables  : c.variables,
      });
    }
  });

  audit(req, 'campaign.create', `companies/${req.params.id}/campaigns/${campaignId}`,
    { name, contacts: contacts.length, rejected: rejected.length, duplicates });
  res.status(201).json({
    id: campaignId, name, contacts: contacts.length, status: 'draft',
    // Surfaced so the UI can tell the operator exactly what didn't import.
    rejectedCount : rejected.length,
    rejectedSample: rejected.slice(0, 10),
    duplicates,
  });
});

// List campaigns with progress stats.
router.get('/', async (req, res) => {
  const rows = await sql.listCampaignsForCompany.all(req.params.id);
  const out = [];
  for (const c of rows) {
    const stats = {};
    for (const s of await sql.campaignContactStats.all(c.id)) stats[s.status] = s.n;
    out.push({ ...c, stats });
  }
  res.json(out);
});

// Campaign detail + first page of contacts.
router.get('/:campaignId', async (req, res) => {
  const campaign = await loadOwnedCampaign(req, res);
  if (!campaign) return;
  const stats = {};
  for (const s of await sql.campaignContactStats.all(campaign.id)) stats[s.status] = s.n;
  const contacts = await sql.listCampaignContacts.all(campaign.id, Math.min(500, Number(req.query.limit) || 200));
  // phone is encrypted at rest when DATA_ENCRYPTION_KEY is set; the UI needs
  // it readable. Passthrough for plaintext rows written before that.
  res.json({ ...campaign, stats, contacts: decryptRows(contacts, CONTACT_PII_FIELDS) });
});

// Start / pause / cancel.
router.post('/:campaignId/start', async (req, res) => {
  const campaign = await loadOwnedCampaign(req, res);
  if (!campaign) return;
  if (!['draft', 'paused'].includes(campaign.status)) {
    return res.status(409).json({ error: `لا يمكن تشغيل حملة حالتها ${campaign.status}` });
  }
  await sql.startCampaign.run(campaign.id);
  audit(req, 'campaign.start', `campaigns/${campaign.id}`, null);
  res.json({ ok: true, status: 'running' });
});

router.post('/:campaignId/pause', async (req, res) => {
  const campaign = await loadOwnedCampaign(req, res);
  if (!campaign) return;
  if (campaign.status !== 'running') return res.status(409).json({ error: 'الحملة ليست قيد التشغيل' });
  await sql.setCampaignStatus.run({ id: campaign.id, status: 'paused' });
  audit(req, 'campaign.pause', `campaigns/${campaign.id}`, null);
  res.json({ ok: true, status: 'paused' });
});

router.post('/:campaignId/cancel', async (req, res) => {
  const campaign = await loadOwnedCampaign(req, res);
  if (!campaign) return;
  if (['completed', 'cancelled'].includes(campaign.status)) {
    return res.status(409).json({ error: 'الحملة منتهية بالفعل' });
  }
  await sql.cancelCampaignContacts.run(campaign.id);
  await sql.setCampaignStatus.run({ id: campaign.id, status: 'cancelled' });
  audit(req, 'campaign.cancel', `campaigns/${campaign.id}`, null);
  res.json({ ok: true, status: 'cancelled' });
});

module.exports = router;
