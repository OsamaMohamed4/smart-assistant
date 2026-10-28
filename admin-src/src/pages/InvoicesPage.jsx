import { useEffect, useMemo, useState } from 'react';
import { Receipt, Send, FileText, Mail, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Label } from '../components/ui/Input';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtDate, fmtSar, recentMonths, MONTHS_AR } from '../lib/utils';

// Counts in the same Latin digits as the money beside them, so one card
// never mixes two scripts of numerals.
const n = (v) => Number(v || 0).toLocaleString('en-US');
// "2026-10-01" → "1 أكتوبر 2026": a hyphenated date inside Arabic text is
// reordered by the bidi algorithm.
const arDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `${Number(m[3])} ${MONTHS_AR[Number(m[2]) - 1]} ${m[1]}` : (d || '—');
};

// Monthly invoices per contract. A superadmin sets each company's contract,
// previews a month, issues and e-mails it; a company account sees the
// invoices issued to it. The rules themselves are server-side
// (lib/invoice.js) so the preview, the e-mail and the printed copy agree.

const STATUS = {
  sent  : { label: 'أُرسلت', tone: 'bg-emerald-50 text-emerald-700' },
  issued: { label: 'صدرت', tone: 'bg-sky-50 text-sky-700' },
  failed: { label: 'لم تُرسل', tone: 'bg-rose-50 text-rose-700' },
};
const inputCls = 'w-full h-10 px-3 rounded-xl border border-ink-200 bg-white text-[13px] focus-ring';
const open = (url) => window.open(url, '_blank', 'noopener');

// WhatsApp's Enterprise package is priced by agreement, so its figures are
// entered per company (lib/whatsapp-billing.js).
const WA_CUSTOM_EMPTY = { monthlyFee: '', conversations: '', messages: '', extraConversation: '', extraMessage: '' };
const WA_CUSTOM_FIELDS = [
  ['monthlyFee', 'السعر الشهري (ر.س)', '0.01'],
  ['conversations', 'المحادثات المشمولة', '1'],
  ['messages', 'الرسائل المشمولة', '1'],
  ['extraConversation', 'سعر المحادثة الإضافية (ر.س)', '0.00001'],
  ['extraMessage', 'سعر الرسالة الإضافية (ر.س)', '0.00001'],
];

export function InvoicesPage({ user, pinnedCompanyId }) {
  const isSuper = user?.role === 'superadmin' && !pinnedCompanyId;
  return isSuper ? <AdminInvoices /> : <CompanyInvoices companyId={pinnedCompanyId || user?.companyId} />;
}

// ─── A company's own invoices ──────────────────────────────────────
function CompanyInvoices({ companyId }) {
  const { push } = useToast();
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!companyId) return;
    api.listInvoices(companyId).then(setList).catch((e) => push(e.message, 'error'));
  }, [companyId]);
  return (
    <div>
      <TopBar title="الفواتير" subtitle="الفواتير الشهرية الصادرة لشركتكم حسب العقد." />
      <div className="px-8 py-7 max-w-4xl">
        {list && !list.length ? (
          <EmptyState icon={Receipt} title="لا توجد فواتير بعد" description="تظهر هنا الفواتير الشهرية عند إصدارها." />
        ) : (
          <InvoiceTable list={list || []} />
        )}
      </div>
    </div>
  );
}

function InvoiceTable({ list, onResend }) {
  if (!list.length) return null;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-[13px] whitespace-nowrap">
        <thead>
          <tr className="bg-ink-50/80 text-[11.5px] text-ink-500">
            <th className="text-right font-medium px-5 py-3">رقم الفاتورة</th>
            <th className="text-right font-medium px-4 py-3">الشهر</th>
            <th className="text-right font-medium px-4 py-3">الإجمالي (ر.س)</th>
            <th className="text-right font-medium px-4 py-3">الحالة</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {list.map((inv) => {
            const st = STATUS[inv.status] || STATUS.issued;
            return (
              <tr key={inv.id} className="border-t border-ink-100 align-top">
                <td className="px-5 py-3 font-mono text-ink-800" dir="ltr">{inv.number}</td>
                <td className="px-4 py-3 text-ink-700">{monthName(inv.month)}</td>
                <td className="px-4 py-3 tabular-nums font-semibold" dir="ltr">{fmtSar(inv.total)}</td>
                <td className="px-4 py-3">
                  <span className={cn('inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold', st.tone)}>{st.label}</span>
                  {inv.status === 'sent' && inv.sent_at && <div className="text-[11px] text-ink-500 mt-1">{fmtDate(inv.sent_at)}</div>}
                  {inv.status === 'failed' && inv.error && <div className="text-[11px] text-rose-700 mt-1 max-w-[260px] whitespace-normal">{inv.error}</div>}
                </td>
                <td className="px-4 py-3 text-left">
                  <div className="flex items-center justify-end gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => open(`/api/invoices/${inv.id}/html`)}>
                      <FileText className="w-3.5 h-3.5" /> عرض
                    </Button>
                    {onResend && (
                      <Button size="sm" variant="secondary" onClick={() => onResend(inv)}>
                        <Send className="w-3.5 h-3.5" /> إرسال
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

const monthName = (m) => recentMonths(36).find((x) => x.value === m)?.label || m;

// ─── Superadmin ────────────────────────────────────────────────────
function AdminInvoices() {
  const { push } = useToast();
  const months = useMemo(() => recentMonths(13), []);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(null);
  const [contract, setContract] = useState(null);
  // The WhatsApp packages (the client's table), as the server holds them.
  const [waPackages, setWaPackages] = useState({});
  const [month, setMonth] = useState(months[1]?.value || months[0].value);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api.listCompanies().then((cs) => {
      setCompanies(cs || []);
      setCompanyId((cur) => cur || cs?.[0]?.id || null);
    }).catch((e) => push(e.message, 'error'));
  }, []);

  const loadList = () => companyId && api.listInvoices(companyId).then(setList).catch(() => {});
  const loadPreview = () => {
    if (!companyId) return;
    setPreview(null); setPreviewError('');
    api.invoicePreview(companyId, month).then(setPreview).catch((e) => setPreviewError(e.message));
  };
  useEffect(() => {
    if (!companyId) return;
    api.companyContract(companyId).then((r) => {
      setWaPackages(r.whatsappPackages || {});
      setContract({
        ...r.contract,
        billingEmails: (r.contract.billingEmails || []).join(', '),
        startDate: r.contract.startDate || '',
        whatsapp: { package: r.contract.whatsapp?.package || '', custom: { ...WA_CUSTOM_EMPTY, ...(r.contract.whatsapp?.custom || {}) } },
      });
    }).catch((e) => push(e.message, 'error'));
    loadList();
  }, [companyId]);
  useEffect(() => { loadPreview(); }, [companyId, month]);

  const set = (k) => (v) => setContract((c) => ({ ...c, [k]: v }));
  const setTier = (i, k, v) => setContract((c) => ({ ...c, tiers: c.tiers.map((t, j) => (j === i ? { ...t, [k]: v } : t)) }));
  const setWa = (k) => (v) => setContract((c) => ({ ...c, whatsapp: { ...c.whatsapp, [k]: v } }));
  const setWaCustom = (k) => (v) => setContract((c) => ({ ...c, whatsapp: { ...c.whatsapp, custom: { ...c.whatsapp.custom, [k]: v } } }));

  const saveContract = async () => {
    setBusy('contract');
    try {
      const body = {
        ...contract,
        months: Number(contract.months), includedOutboundCalls: Number(contract.includedOutboundCalls),
        minBillableSeconds: Number(contract.minBillableSeconds), unitSeconds: Number(contract.unitSeconds),
        monthlyFee: Number(contract.monthlyFee || 0), vatRate: Number(contract.vatRate || 0),
        tiers: contract.tiers.map((t) => ({ upTo: Number(t.upTo), price: Number(t.price) })),
        whatsapp: contract.whatsapp.package ? {
          package: contract.whatsapp.package,
          custom: Object.fromEntries(Object.entries(contract.whatsapp.custom).map(([k, v]) => [k, Number(v)])),
        } : null,
      };
      await api.saveCompanyContract(companyId, body);
      push('تم حفظ العقد', 'success');
      loadPreview();
    } catch (e) { push(e.message, 'error'); }
    finally { setBusy(''); }
  };

  const issue = async () => {
    if (!confirm(`إصدار فاتورة ${months.find((m) => m.value === month)?.label} وإرسالها إلى: ${contract?.billingEmails || '—'}؟`)) return;
    setBusy('issue');
    try {
      const r = await api.issueInvoice(companyId, month);
      if (r.sent && !r.sent.ok) push(`صدرت الفاتورة ${r.invoice.number} ولم تُرسل: ${r.sent.error}`, 'error');
      else push(`صدرت الفاتورة ${r.invoice.number} وأُرسلت`, 'success');
      loadList(); loadPreview();
    } catch (e) { push(e.message, 'error'); }
    finally { setBusy(''); }
  };

  const resend = async (inv) => {
    try {
      await api.resendInvoice(inv.id);
      push(`أُرسلت الفاتورة ${inv.number}`, 'success');
    } catch (e) { push(e.message, 'error'); }
    loadList();
  };

  const c = preview?.computed;
  return (
    <div>
      <TopBar
        title="الفواتير"
        subtitle="الفواتير الشهرية لكل شركة حسب عقدها، تُصدر وتُرسل إلى بريد الفوترة."
        right={companies.length > 1 && (
          <select value={companyId || ''} onChange={(e) => setCompanyId(e.target.value)}
            className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring">
            {companies.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
          </select>
        )}
      />
      <div className="px-8 py-7 space-y-6 max-w-5xl">
        {/* ─── This month ─── */}
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[14px] font-semibold text-ink-900">فاتورة الشهر</div>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring">
              {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          {previewError ? (
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-[13px] text-amber-900">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {previewError}
            </div>
          ) : c ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat label="مكالمات صادرة محتسبة" value={n(c.outbound.units)} hint={`من ${n(c.outbound.calls)} مكالمة`} />
                <Stat label="من الباقة" value={n(c.outbound.includedUsed)} hint={`المتبقي ${n(c.outbound.includedLeft)}`} />
                <Stat label="إضافية" value={n(c.outbound.extra)} hint={c.needsQuote ? 'جزء منها بعرض خاص' : ''} />
                <Stat label="الإجمالي (ر.س)" value={fmtSar(c.total)} strong hint={c.vat ? `يشمل ضريبة ${fmtSar(c.vat)}` : 'قبل أي ضريبة'} />
              </div>
              {c.whatsapp && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label={`محادثات واتساب (${c.whatsapp.labelAr})`} value={n(c.whatsapp.conversations)} hint={`المشمول ${n(c.whatsapp.included.conversations)}`} />
                  <Stat label="رسائل واتساب" value={n(c.whatsapp.messages)} hint={`المشمول حتى ${n(c.whatsapp.messageAllowance)}`} />
                  <Stat label="محادثات ورسائل إضافية" value={`${n(c.whatsapp.extraConversations)} · ${n(c.whatsapp.extraMessages)}`} />
                  <Stat label="واتساب (ر.س)" value={fmtSar(c.whatsapp.total)} hint="الباقة والإضافي، قبل الضريبة" />
                </div>
              )}
              <div className="text-[12px] text-ink-500">
                الفترة: {arDate(preview.period.from)} إلى {arDate(preview.period.to)} · الواردة: {n(c.inbound.calls)} مكالمة (غير محدودة)
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="secondary" onClick={() => open(`/api/companies/${companyId}/invoices/preview.html?month=${month}`)}>
                  <FileText className="w-3.5 h-3.5" /> معاينة الفاتورة
                </Button>
                {preview.issued ? (
                  <span className="text-[12.5px] text-ink-600">صدرت لهذا الشهر برقم <span className="font-mono" dir="ltr">{preview.issued.number}</span></span>
                ) : (
                  <Button variant="brand" onClick={issue} loading={busy === 'issue'}>
                    <Send className="w-3.5 h-3.5" /> إصدار وإرسال
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="text-[13px] text-ink-400">جارٍ الحساب…</div>
          )}
        </Card>

        <InvoiceTable list={list} onResend={resend} />

        {/* ─── The contract ─── */}
        {contract && (
          <Card className="p-5 space-y-4">
            <div className="text-[14px] font-semibold text-ink-900">العقد</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><Label>تاريخ بداية العقد</Label><input type="date" value={contract.startDate} onChange={(e) => set('startDate')(e.target.value)} className={inputCls} /></div>
              <div><Label>مدة العقد (شهر)</Label><input type="number" min="1" value={contract.months} onChange={(e) => set('months')(e.target.value)} className={inputCls} /></div>
              <div><Label>المكالمات الصادرة المشمولة</Label><input type="number" min="0" value={contract.includedOutboundCalls} onChange={(e) => set('includedOutboundCalls')(e.target.value)} className={inputCls} /></div>
            </div>

            <div>
              <Label>أسعار المكالمات الصادرة الإضافية (شهرياً، تدريجية)</Label>
              <div className="space-y-2">
                {contract.tiers.map((t, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr] gap-2 items-center">
                    <div className="flex items-center gap-2 text-[12.5px] text-ink-600">
                      <span className="whitespace-nowrap">حتى المكالمة</span>
                      <input type="number" value={t.upTo} onChange={(e) => setTier(i, 'upTo', e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex items-center gap-2 text-[12.5px] text-ink-600">
                      <span className="whitespace-nowrap">سعر المكالمة (ر.س)</span>
                      <input type="number" step="0.01" value={t.price} onChange={(e) => setTier(i, 'price', e.target.value)} className={inputCls} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] text-ink-500">ما يزيد على آخر شريحة يُسعَّر بعرض سعر خاص ولا يُحسب في الفاتورة.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><Label>أقل مدة تُحتسب (ثانية)</Label><input type="number" min="0" value={contract.minBillableSeconds} onChange={(e) => set('minBillableSeconds')(e.target.value)} className={inputCls} /></div>
              <div><Label>مدة المكالمة الواحدة (ثانية)</Label><input type="number" min="1" value={contract.unitSeconds} onChange={(e) => set('unitSeconds')(e.target.value)} className={inputCls} /></div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><Label>رسوم شهرية ثابتة (اختياري، ر.س)</Label><input type="number" min="0" step="0.01" value={contract.monthlyFee} onChange={(e) => set('monthlyFee')(e.target.value)} className={inputCls} /></div>
              <div>
                <Label>ضريبة القيمة المضافة</Label>
                <select value={contract.vat} onChange={(e) => set('vat')(e.target.value)} className={inputCls}>
                  <option value="none">لا تُضاف</option>
                  <option value="add">تُضاف فوق الأسعار</option>
                </select>
              </div>
              {contract.vat === 'add' && (
                <div><Label>نسبة الضريبة (%)</Label><input type="number" min="0" max="100" value={contract.vatRate} onChange={(e) => set('vatRate')(e.target.value)} className={inputCls} /></div>
              )}
            </div>

            <div className="space-y-2">
              <Label>باقة واتساب</Label>
              <select value={contract.whatsapp.package} onChange={(e) => setWa('package')(e.target.value)} className={inputCls}>
                <option value="">لا تُحتسب واتساب في الفاتورة</option>
                {Object.entries(waPackages).map(([k, p]) => (
                  <option key={k} value={k}>
                    {p.labelAr} — {n(p.monthlyFee)} ر.س شهرياً: {n(p.conversations)} محادثة و{n(p.messages)} رسالة
                  </option>
                ))}
                <option value="enterprise">Enterprise — تسعير خاص</option>
              </select>
              {waPackages[contract.whatsapp.package] && (
                <p className="text-[11.5px] text-ink-500">
                  المحادثة الإضافية {waPackages[contract.whatsapp.package].extraConversation} ر.س، والرسالة الإضافية {waPackages[contract.whatsapp.package].extraMessage} ر.س.
                </p>
              )}
              {contract.whatsapp.package === 'enterprise' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {WA_CUSTOM_FIELDS.map(([k, label, step]) => (
                    <div key={k}><Label>{label}</Label><input type="number" min="0" step={step} value={contract.whatsapp.custom[k]} onChange={(e) => setWaCustom(k)(e.target.value)} className={inputCls} /></div>
                  ))}
                </div>
              )}
              <p className="text-[11.5px] text-ink-500 leading-relaxed">
                المحادثة: رقم عميل واحد خلال 24 ساعة من أول رسالة، وتُحتسب إذا أرسل فيها المساعد رداً أو رسالة. رسائلها رسائل العميل والمساعد معاً.
                لكل محادثة إضافية نصيبها من رسائل الباقة (8 رسائل في الباقات الأربع)، وما زاد على ذلك يُحتسب بسعر الرسالة.
              </p>
            </div>

            <div>
              <Label>بريد الفوترة للشركة</Label>
              <input value={contract.billingEmails} onChange={(e) => set('billingEmails')(e.target.value)} dir="ltr"
                placeholder="billing@company.sa, finance@company.sa" className={inputCls} />
            </div>

            <label className="flex items-start gap-3 rounded-xl border border-ink-100 px-4 py-3 cursor-pointer">
              <input type="checkbox" className="mt-1 w-4 h-4 accent-brand-600" checked={!!contract.autoSend} onChange={(e) => set('autoSend')(e.target.checked)} />
              <span>
                <span className="block text-[13px] font-medium text-ink-900">إرسال الفاتورة تلقائياً أول كل شهر</span>
                <span className="block text-[12px] text-ink-500 mt-0.5">تصدر فاتورة الشهر السابق وتُرسل إلى بريد الفوترة في الأيام الأولى من كل شهر، صباحاً بتوقيت الرياض.</span>
              </span>
            </label>

            <div className="flex justify-end">
              <Button variant="brand" onClick={saveContract} loading={busy === 'contract'}>حفظ العقد</Button>
            </div>
          </Card>
        )}

        <SellerCard />
      </div>
    </div>
  );
}

function Stat({ label, value, hint, strong }) {
  return (
    <div className="rounded-xl bg-ink-50/60 px-4 py-3">
      <div className={cn('text-[20px] tabular-nums leading-none', strong ? 'font-bold text-brand-700' : 'font-bold text-ink-900')} dir="ltr">{value}</div>
      <div className="mt-1.5 text-[11.5px] text-ink-600">{label}</div>
      {hint && <div className="text-[11px] text-ink-400 mt-0.5">{hint}</div>}
    </div>
  );
}

// The seller's details printed on every invoice, and the mailbox they leave from.
function SellerCard() {
  const { push } = useToast();
  const [data, setData] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { api.billingProfile().then(setData).catch((e) => push(e.message, 'error')); }, []);
  if (!data) return null;
  const p = data.profile;
  const set = (k) => (e) => setData((d) => ({ ...d, profile: { ...d.profile, [k]: e.target.value } }));
  const save = async () => {
    setBusy('save');
    try { setData({ ...data, ...(await api.saveBillingProfile(p)) }); push('تم حفظ بيانات المُصدِر', 'success'); }
    catch (e) { push(e.message, 'error'); }
    finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test');
    try { await api.testMail(testTo); push(`أُرسلت رسالة تجريبية إلى ${testTo}`, 'success'); }
    catch (e) { push(e.message, 'error'); }
    finally { setBusy(''); }
  };
  const fields = [
    ['name', 'اسم المُصدِر (الكيان النظامي)'], ['brand', 'العلامة'], ['crNumber', 'السجل التجاري'],
    ['vatNumber', 'الرقم الضريبي'], ['address', 'العنوان'], ['email', 'البريد'], ['phone', 'الهاتف'],
  ];
  return (
    <Card className="p-5 space-y-4">
      <div className="text-[14px] font-semibold text-ink-900">بيانات المُصدِر والبريد</div>
      <div className={cn('flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px]', data.mail.configured ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-900')}>
        {data.mail.configured ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
        <div>
          {data.mail.configured
            ? <>الفواتير تُرسل من <span dir="ltr" className="font-mono">{data.mail.sender}</span> ({data.mail.transport === 'graph' ? 'Microsoft Graph' : 'SMTP'}).</>
            : <>البريد غير مضبوط على الخادم: أضف SMTP_HOST وSMTP_PORT وSMTP_USER وSMTP_PASS في Railway.</>}
        </div>
      </div>
      {data.mail.configured && (
        <div className="flex gap-2">
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="بريد لاستلام رسالة تجريبية" dir="ltr" className={inputCls} />
          <Button variant="secondary" onClick={test} loading={busy === 'test'} disabled={!testTo} className="whitespace-nowrap shrink-0"><Mail className="w-3.5 h-3.5" /> رسالة تجريبية</Button>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {fields.map(([k, label]) => (
          <div key={k}><Label>{label}</Label><input value={p[k] || ''} onChange={set(k)} className={inputCls} dir={['email', 'phone', 'crNumber', 'vatNumber'].includes(k) ? 'ltr' : undefined} /></div>
        ))}
      </div>
      <div className="flex justify-end"><Button variant="brand" onClick={save} loading={busy === 'save'}>حفظ</Button></div>
    </Card>
  );
}
