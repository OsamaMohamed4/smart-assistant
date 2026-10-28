// Monthly invoices: built from each company's contract and its calls, issued
// once per company per month, and e-mailed to the company's billing
// addresses from the platform's mailbox.
//
// The contract lives in the company's settings (`contract`), set by a
// superadmin: start date, length, included calls, tiers, call-unit rules,
// an optional monthly fee, VAT, billing e-mails, and whether to send on its
// own. The money rules are in lib/invoice.js; this file is the I/O around
// them.
//
// Issuing takes a SNAPSHOT (lines, counts, terms, seller, buyer). The invoice
// a company received never changes afterwards, whatever is edited later.
const { computeInvoice, contractPeriod, unitsFor, DEFAULT_CONTRACT, sar } = require('../lib/invoice');
const waBilling = require('../lib/whatsapp-billing');
const { saudiMonthRange, currentSaudiMonth, TZ_OFFSET_HOURS } = require('../lib/usage-report');
const mailer = require('../lib/mailer');

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const OFFSET_MS = TZ_OFFSET_HOURS * 3600 * 1000;
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const fromStamp = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);

// Saudi midnight of a YYYY-MM-DD, as a UTC storage stamp.
const saudiDayStart = (date) => stamp(Date.parse(`${date}T00:00:00Z`) - OFFSET_MS);
// The Saudi calendar date of a UTC stamp.
const saudiDate = (s) => new Date(fromStamp(s) + OFFSET_MS).toISOString().slice(0, 10);
const saudiToday = (now = new Date()) => new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
const monthLabel = (month) => { const [y, m] = month.split('-').map(Number); return `${MONTHS_AR[m - 1]} ${y}`; };
// "2026-10-01" → "1 أكتوبر 2026". Written out because a hyphenated date
// inside Arabic text is reordered by the bidi algorithm into nonsense.
const arDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `${Number(m[3])} ${MONTHS_AR[Number(m[2]) - 1]} ${m[1]}` : (d || '—');
};

function previousSaudiMonth(now = new Date()) {
  const [y, m] = currentSaudiMonth(now).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/;

/** The company's contract with the defaults from the contract filled in. */
function contractOf(company) {
  const raw = company?.settings?.contract;
  const c = { ...DEFAULT_CONTRACT, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.billingEmails = Array.isArray(c.billingEmails) ? c.billingEmails : [];
  return c;
}

// ─── Settings, validated ───────────────────────────────────────────
function validateContract(b) {
  const out = {};
  const startDate = String(b?.startDate || '').trim();
  if (startDate && !contractPeriod(startDate, 12)) return { error: 'تاريخ بداية العقد غير صحيح (YYYY-MM-DD)' };
  out.startDate = startDate || null;
  const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
  out.months = int(b?.months ?? 12, 1, 120);
  out.includedOutboundCalls = int(b?.includedOutboundCalls ?? DEFAULT_CONTRACT.includedOutboundCalls, 0, 10_000_000);
  out.minBillableSeconds = int(b?.minBillableSeconds ?? 60, 0, 3600);
  out.unitSeconds = int(b?.unitSeconds ?? 240, 1, 36_000);
  if ([out.months, out.includedOutboundCalls, out.minBillableSeconds, out.unitSeconds].includes(null)) return { error: 'قيم العقد غير صحيحة' };
  const tiers = Array.isArray(b?.tiers) ? b.tiers : DEFAULT_CONTRACT.tiers;
  out.tiers = [];
  let prev = 0;
  for (const t of tiers.slice(0, 10)) {
    const upTo = Number(t?.upTo); const price = Number(t?.price);
    if (!Number.isInteger(upTo) || upTo <= prev || !Number.isFinite(price) || price < 0 || price > 10_000) {
      return { error: 'شرائح الأسعار غير صحيحة: كل شريحة أكبر من التي قبلها، وسعرها رقم' };
    }
    out.tiers.push({ upTo, price: Math.round(price * 100) / 100 });
    prev = upTo;
  }
  const fee = Number(b?.monthlyFee ?? 0);
  if (!Number.isFinite(fee) || fee < 0) return { error: 'الرسوم الشهرية غير صحيحة' };
  out.monthlyFee = Math.round(fee * 100) / 100;
  // The WhatsApp package, from the client's table (lib/whatsapp-billing.js).
  const wa = waBilling.validate(b?.whatsapp);
  if (wa.error) return { error: wa.error };
  out.whatsapp = wa.whatsapp;
  out.vat = b?.vat === 'add' ? 'add' : 'none';
  out.vatRate = Number.isFinite(Number(b?.vatRate)) ? Math.min(100, Math.max(0, Number(b.vatRate))) : 15;
  const emails = (Array.isArray(b?.billingEmails) ? b.billingEmails : String(b?.billingEmails || '').split(/[,\s;]+/))
    .map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const bad = emails.find((e) => !EMAIL_RE.test(e));
  if (bad) return { error: `بريد الفوترة غير صالح: ${bad}` };
  out.billingEmails = [...new Set(emails)].slice(0, 10);
  out.autoSend = b?.autoSend === true;
  if (out.autoSend && (!out.startDate || !out.billingEmails.length)) {
    return { error: 'الإرسال الشهري التلقائي يحتاج تاريخ بداية العقد وبريد فوترة' };
  }
  return { contract: out };
}

const PROFILE_KEYS = ['brand', 'name', 'crNumber', 'vatNumber', 'address', 'email', 'phone'];
function defaultProfile() {
  // The legal entity and the contact lines the public site already shows.
  return {
    brand: 'مسار', name: 'مؤسسة العنود محمد القحطاني لتقنية المعلومات', crNumber: '', vatNumber: '', address: '',
    email: mailer.sender() || 'info@getmasar.sa', phone: '9200 33842',
  };
}
async function billingProfile(deps) {
  let stored = {};
  try { stored = JSON.parse((await deps.sql.getPlatformSetting.get('billing_profile'))?.value || '{}') || {}; } catch {}
  const p = defaultProfile();
  for (const k of PROFILE_KEYS) if (typeof stored[k] === 'string') p[k] = stored[k];
  return p;
}
function validateProfile(b) {
  const p = {};
  for (const k of PROFILE_KEYS) p[k] = String(b?.[k] ?? '').trim().slice(0, 200);
  if (!p.name) return { error: 'اسم المُصدِر مطلوب' };
  if (p.email && !EMAIL_RE.test(p.email)) return { error: 'بريد المُصدِر غير صالح' };
  return { profile: p };
}

// ─── Building one month ────────────────────────────────────────────
async function buildInvoice(company, month, deps) {
  const c = contractOf(company);
  const period = contractPeriod(c.startDate, c.months);
  if (!period) return { error: 'حدّد تاريخ بداية العقد أولاً' };
  const range = saudiMonthRange(month);
  if (!range) return { error: 'صيغة الشهر غير صحيحة — المطلوب YYYY-MM' };
  const startUtc = saudiDayStart(period.start);
  const endUtc = saudiDayStart(period.end);
  const from = range.from > startUtc ? range.from : startUtc;
  const to = range.to < endUtc ? range.to : endUtc;
  if (from >= to) return { error: 'هذا الشهر خارج مدة العقد' };

  const before = startUtc < from ? await deps.sql.listOutboundDurations.all(company.id, startUtc, from) : [];
  const unitsBefore = unitsFor(before.map((r) => r.duration_sec), c);
  const month_ = await deps.sql.listOutboundDurations.all(company.id, from, to);
  const inbound = (await deps.sql.inboundTotals.get(company.id, from, to)) || { calls: 0, seconds: 0 };
  // WhatsApp, when the contract names a package: its conversations and
  // messages over the same period, priced by the package.
  const waTerms = waBilling.termsOf(c);
  const whatsapp = waTerms
    ? waBilling.compute(waTerms, waBilling.countConversations(
      await deps.sql.listWhatsappForBilling.all({ company_id: company.id, from, to }), from, to))
    : null;
  const computed = computeInvoice({
    contract: c, unitsBefore,
    monthDurations: month_.map((r) => r.duration_sec),
    inbound: { calls: Number(inbound.calls) || 0, seconds: Number(inbound.seconds) || 0 },
    whatsapp,
  });
  return {
    invoice: {
      month, monthLabel: monthLabel(month),
      period: { from: saudiDate(from), to: saudiDate(stamp(fromStamp(to) - 1000)) },
      company: { id: company.id, name: company.name },
      contract: {
        startDate: period.start, endDate: saudiDate(stamp(fromStamp(endUtc) - 1000)), months: c.months,
        includedOutboundCalls: c.includedOutboundCalls, minBillableSeconds: c.minBillableSeconds,
        unitSeconds: c.unitSeconds, tiers: c.tiers, vat: c.vat, vatRate: c.vatRate, monthlyFee: c.monthlyFee,
        whatsapp: waTerms,
      },
      computed,
    },
  };
}

async function nextNumber(deps, now = new Date()) {
  const year = saudiToday(now).slice(0, 4);
  const prefix = `MSR-${year}-`;
  const last = (await deps.sql.lastInvoiceNumber.get(`${prefix}%`))?.number;
  const seq = last ? Number(last.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/** Issue a month's invoice (once), returning the stored row. */
async function issueInvoice(company, month, deps, { actor = null } = {}) {
  const existing = await deps.sql.getInvoiceForMonth.get(company.id, month);
  if (existing) return { invoice: existing, existed: true };
  const built = await buildInvoice(company, month, deps);
  if (built.error) return built;
  const seller = await billingProfile(deps);
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextNumber(deps);
    const snapshot = { ...built.invoice, number, issueDate: saudiToday(), seller };
    const r = await deps.sql.insertInvoice.run({
      company_id: company.id, number, month,
      subtotal: snapshot.computed.subtotal, vat: snapshot.computed.vat, total: snapshot.computed.total,
      data: JSON.stringify(snapshot), status: 'issued', created_by: actor,
    });
    if (r.changes) return { invoice: await deps.sql.getInvoice.get(r.lastInsertRowid) };
    const raced = await deps.sql.getInvoiceForMonth.get(company.id, month);
    if (raced) return { invoice: raced, existed: true };
  }
  return { error: 'تعذّر ترقيم الفاتورة، حاول مرة أخرى' };
}

/** E-mail an issued invoice to the company's billing addresses. */
async function sendInvoice(row, company, deps, { siteUrl = null } = {}) {
  const to = contractOf(company).billingEmails;
  const record = (status, error, sentTo) => deps.sql.updateInvoiceDelivery.run({
    id: row.id, status, sent_to: sentTo || null, sent_at: status === 'sent' ? stamp(Date.now()) : null, error: error || null,
  });
  if (!to.length) {
    await record('failed', 'لا يوجد بريد فوترة لهذه الشركة');
    return { ok: false, error: 'لا يوجد بريد فوترة لهذه الشركة' };
  }
  const snap = JSON.parse(row.data);
  const res = await mailer.sendMail({
    to,
    subject: `فاتورة ${snap.seller?.brand || 'مسار'} — ${snap.monthLabel} — ${snap.number}`,
    html: renderInvoiceHtml(snap, { siteUrl }),
    text: renderInvoiceText(snap),
  });
  await record(res.ok ? 'sent' : 'failed', res.ok ? null : res.error, to.join(', '));
  return res;
}

// ─── Rendering ─────────────────────────────────────────────────────
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const minutes = (sec) => Math.round((Number(sec) || 0) / 60).toLocaleString('en-US');

function invoiceRows(s) {
  const c = s.computed;
  const rows = [];
  rows.push(['المكالمات الواردة', `${num(c.inbound.calls)} مكالمة (${minutes(c.inbound.seconds)} دقيقة)`, '—', 'غير محدودة']);
  rows.push(['المكالمات الصادرة من الباقة', `${num(c.outbound.includedUsed)} مكالمة`, '—', sar(0)]);
  for (const l of c.lines) {
    rows.push([`مكالمات صادرة إضافية (${num(l.from)}–${num(l.to)})`, `${num(l.units)} مكالمة`, sar(l.unitPrice), sar(l.amount)]);
  }
  if (c.outbound.beyondTiers > 0) {
    rows.push([`مكالمات صادرة إضافية فوق ${num(s.contract.tiers.at(-1)?.upTo || 0)}`, `${num(c.outbound.beyondTiers)} مكالمة`, '—', 'حسب عرض السعر الخاص']);
  }
  if (c.monthlyFee > 0) rows.push(['الرسوم الشهرية', '1', sar(c.monthlyFee), sar(c.monthlyFee)]);
  const w = c.whatsapp;
  if (w) {
    rows.push([`باقة واتساب ${w.labelAr} (${num(w.included.conversations)} محادثة و${num(w.included.messages)} رسالة)`, '1', sar(w.fee), sar(w.fee)]);
    for (const l of w.lines) {
      rows.push(l.key === 'conversations'
        ? ['محادثات واتساب إضافية', `${num(l.units)} محادثة`, waBilling.unitSar(l.unitPrice), sar(l.amount)]
        : ['رسائل واتساب إضافية', `${num(l.units)} رسالة`, waBilling.unitSar(l.unitPrice), sar(l.amount)]);
    }
  }
  return rows;
}

// The WhatsApp counts behind the lines, and how they are counted, in words.
function whatsappNotes(w) {
  if (!w) return [];
  return [
    `واتساب هذا الشهر: ${num(w.conversations)} محادثة و${num(w.messages)} رسالة. المشمول: ${num(w.included.conversations)} محادثة، ورسائل حتى ${num(w.messageAllowance)}${w.extraConversations ? ' مع رسائل المحادثات الإضافية' : ''}.`,
    'طريقة الاحتساب: المحادثة رقم عميل واحد خلال 24 ساعة من أول رسالة، وتُحتسب إذا أرسل فيها المساعد رداً أو رسالة. رسائلها رسائل العميل والمساعد معاً، ولكل محادثة إضافية رسائلها من الباقة.',
  ];
}

function renderInvoiceHtml(s, { siteUrl = null } = {}) {
  const c = s.computed;
  const seller = s.seller || {};
  const td = 'padding:10px 12px;border-bottom:1px solid #E6E0D6;font-size:14px;color:#1A150E;';
  const th = 'padding:10px 12px;background:#F3EFE8;font-size:12px;color:#3F3D4A;text-align:right;font-weight:600;';
  const meta = [
    ['رقم الفاتورة', s.number || 'معاينة — لم تُصدر بعد'],
    ['تاريخ الإصدار', s.issueDate ? arDate(s.issueDate) : '—'],
    ['الفترة', `${arDate(s.period.from)} إلى ${arDate(s.period.to)}`],
    ['العميل', s.company.name],
  ];
  const sellerLines = [
    seller.name,
    seller.crNumber && `سجل تجاري: ${seller.crNumber}`,
    seller.vatNumber && `الرقم الضريبي: ${seller.vatNumber}`,
    seller.address,
    [seller.email, seller.phone].filter(Boolean).join(' · '),
  ].filter(Boolean);
  const total = (label, value, strong) => `<tr><td colspan="3" style="${td}text-align:left;${strong ? 'font-weight:700;' : 'color:#3F3D4A;'}">${esc(label)}</td><td style="${td}${strong ? 'font-weight:700;' : ''}white-space:nowrap;" dir="ltr">${esc(value)} ر.س</td></tr>`;

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.number || 'معاينة فاتورة')} — ${esc(s.company.name)}</title>
<style>@page{size:A4;margin:16mm}body{margin:0;background:#FAF8F5;font-family:'Segoe UI',Tahoma,Arial,sans-serif}@media print{body{background:#fff}}</style>
</head><body>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F5;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border:1px solid #E6E0D6;border-radius:8px;">
  <tr><td style="padding:28px 28px 8px;">
    <table role="presentation" width="100%"><tr>
      <td style="vertical-align:top;">
        <div style="font-size:22px;font-weight:700;color:#8439FF;">${esc(seller.brand || 'مسار')}</div>
        ${sellerLines.map((l) => `<div style="font-size:12.5px;color:#3F3D4A;line-height:1.8;">${esc(l)}</div>`).join('')}
      </td>
      <td style="vertical-align:top;text-align:left;">
        <div style="font-size:20px;font-weight:700;color:#1A150E;">${s.number ? 'فاتورة' : 'معاينة فاتورة'}</div>
        <div style="font-size:13px;color:#7A7166;margin-top:4px;">${esc(s.monthLabel)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:12px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F5;border-radius:6px;">
      ${meta.map(([k, v]) => `<tr><td style="padding:6px 12px;font-size:12.5px;color:#7A7166;width:130px;">${esc(k)}</td><td style="padding:6px 12px;font-size:13.5px;color:#1A150E;font-weight:600;">${esc(v)}</td></tr>`).join('')}
    </table>
  </td></tr>
  <tr><td style="padding:8px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E6E0D6;border-radius:6px;border-collapse:separate;">
      <tr><th style="${th}">البند</th><th style="${th}">الكمية</th><th style="${th}">سعر الوحدة</th><th style="${th}">المبلغ (ر.س)</th></tr>
      ${invoiceRows(s).map((r) => `<tr>${r.map((cell, i) => `<td style="${td}${i >= 2 ? 'white-space:nowrap;' : ''}"${i >= 2 ? ' dir="ltr"' : ''}>${esc(cell)}</td>`).join('')}</tr>`).join('')}
      ${total('المجموع قبل الضريبة', sar(c.subtotal), false)}
      ${c.vat > 0 ? total(`ضريبة القيمة المضافة (${c.vatRate}%)`, sar(c.vat), false) : ''}
      ${total('الإجمالي', sar(c.total), true)}
    </table>
  </td></tr>
  <tr><td style="padding:12px 28px 4px;font-size:12.5px;color:#3F3D4A;line-height:1.9;">
    <div>المكالمات الصادرة هذا الشهر: ${num(c.outbound.calls)}، تم الرد على ${num(c.outbound.answered)}، واحتُسب منها ${num(c.outbound.units)} مكالمة.</div>
    <div>الباقة: ${num(s.contract.includedOutboundCalls)} مكالمة صادرة ضمن العقد — المتبقي بعد هذا الشهر: ${num(c.outbound.includedLeft)}.</div>
    <div>طريقة الاحتساب: المكالمة من دقيقة إلى ${Math.round(s.contract.unitSeconds / 60)} دقائق تُحتسب مكالمة واحدة، وكل ${Math.round(s.contract.unitSeconds / 60)} دقائق إضافية مكالمة، والمكالمة الأقل من دقيقة لا تُحتسب. المكالمات الواردة غير محدودة.</div>
    ${whatsappNotes(c.whatsapp).map((l) => `<div>${esc(l)}</div>`).join('')}
    <div>مدة العقد: من ${esc(arDate(s.contract.startDate))} إلى ${esc(arDate(s.contract.endDate))}.</div>
    ${c.needsQuote ? '<div style="color:#9B3B2B;">تجاوز عدد المكالمات الإضافية آخر شريحة، ويُسعَّر الزائد بموجب عرض سعر خاص.</div>' : ''}
  </td></tr>
  ${siteUrl ? `<tr><td style="padding:8px 28px 4px;font-size:12.5px;color:#3F3D4A;">يمكنكم الاطلاع على فواتيركم في لوحة التحكم: <a href="${esc(siteUrl)}/login" style="color:#8439FF;">${esc(siteUrl.replace(/^https?:\/\//, ''))}/login</a></td></tr>` : ''}
  <tr><td style="padding:16px 28px 24px;"></td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function renderInvoiceText(s) {
  const c = s.computed;
  const lines = [
    `${s.seller?.brand || 'مسار'} — ${s.number ? 'فاتورة' : 'معاينة فاتورة'} ${s.monthLabel}`,
    s.number ? `رقم الفاتورة: ${s.number}` : null,
    `العميل: ${s.company.name}`,
    `الفترة: ${arDate(s.period.from)} إلى ${arDate(s.period.to)}`,
    '',
    ...invoiceRows(s).map((r) => `${r[0]}: ${r[1]}${r[3] && r[3] !== '—' ? ` — ${r[3]}` : ''}`),
    '',
    `المجموع قبل الضريبة: ${sar(c.subtotal)} ر.س`,
    c.vat > 0 ? `ضريبة القيمة المضافة (${c.vatRate}%): ${sar(c.vat)} ر.س` : null,
    `الإجمالي: ${sar(c.total)} ر.س`,
    ...(c.whatsapp ? ['', ...whatsappNotes(c.whatsapp)] : []),
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// ─── The monthly run ───────────────────────────────────────────────
// In the first five days of a Saudi month, from 09:00 Riyadh time, every
// company whose contract says so gets last month's invoice issued and sent.
// Running again is harmless: a sent invoice is skipped, and a failed send is
// retried at most every six hours.
const RETRY_MS = 6 * 60 * 60 * 1000;

async function monthlyRun(deps, now = new Date(), { siteUrl = null } = {}) {
  const local = new Date(now.getTime() + OFFSET_MS);
  if (local.getUTCDate() > 5 || local.getUTCHours() < 9) return { skipped: 'outside the sending window' };
  const month = previousSaudiMonth(now);
  const done = [];
  for (const company of await deps.listCompanies()) {
    const c = contractOf(company);
    if (!c.autoSend || !c.startDate || !c.billingEmails.length) continue;
    const existing = await deps.sql.getInvoiceForMonth.get(company.id, month);
    if (existing?.status === 'sent') continue;
    if (existing?.status === 'failed' && now.getTime() - fromStamp(existing.updated_at) < RETRY_MS) continue;
    const issued = existing ? { invoice: existing } : await issueInvoice(company, month, deps, { actor: 'الإصدار الشهري التلقائي' });
    if (issued.error) continue;                     // e.g. a month outside the contract
    const res = await sendInvoice(issued.invoice, company, deps, { siteUrl });
    done.push({ company: company.id, month, ok: res.ok, error: res.error || null });
  }
  return { month, done };
}

module.exports = {
  contractOf, validateContract, billingProfile, validateProfile, buildInvoice, issueInvoice, sendInvoice,
  renderInvoiceHtml, renderInvoiceText, monthlyRun, previousSaudiMonth, saudiDayStart, monthLabel, nextNumber, arDate,
};
