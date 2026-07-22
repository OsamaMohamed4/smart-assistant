import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ArrowRight, Download, RefreshCw, Search, Flame, ThermometerSun, Snowflake,
  PhoneMissed, PhoneOff, PhoneForwarded, Clock, TrendingUp, Users, FileText, Printer,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Input, Label } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';

// Lead categories mirror lib/lead-scoring.js. Colour carries meaning here —
// a manager scanning 500 rows should see the hot leads without reading.
const LEAD_META = {
  hot           : { label: 'عميل ساخن',    tone: 'danger',  icon: Flame,          card: 'from-rose-500 to-orange-500' },
  warm          : { label: 'عميل دافئ',    tone: 'warning', icon: ThermometerSun, card: 'from-amber-400 to-amber-500' },
  cold          : { label: 'عميل بارد',    tone: 'info',    icon: Snowflake,      card: 'from-sky-400 to-sky-500' },
  not_interested   : { label: 'غير مهتم',     tone: 'neutral', icon: PhoneOff,       card: 'from-ink-400 to-ink-500' },
  no_answer        : { label: 'لم يرد',       tone: 'neutral', icon: PhoneMissed,    card: 'from-ink-300 to-ink-400' },
  invalid_number   : { label: 'رقم غير صالح', tone: 'danger',  icon: PhoneOff,       card: 'from-rose-400 to-rose-500' },
  connection_failed: { label: 'تعذّر الاتصال', tone: 'danger',  icon: PhoneOff,      card: 'from-rose-400 to-rose-500' },
  unqualified      : { label: 'غير مصنّف',    tone: 'outline', icon: Users,          card: 'from-ink-300 to-ink-400' },
  pending          : { label: 'لم يُتصل بعد', tone: 'neutral', icon: Clock,          card: 'from-ink-200 to-ink-300' },
};
// Per-call operational outcome (separate axis from lead qualification).
// Mirrors lib/lead-scoring.js OUTCOME.
const OUTCOME_META = {
  completed   : { label: 'أكمل الحوار',  tone: 'success' },
  ended_early : { label: 'أُنهيت مبكراً', tone: 'warning' },
  transferred : { label: 'حُوّلت لموظف',  tone: 'brand' },
  no_answer   : { label: 'لم يتم الرد',  tone: 'info' },
  busy        : { label: 'مشغول',        tone: 'warning' },
  switched_off: { label: 'مغلق',         tone: 'neutral' },
  invalid     : { label: 'رقم غير صحيح', tone: 'danger' },
  failed      : { label: 'تعذّر الاتصال', tone: 'danger' },
  pending     : { label: 'لم يُتصل بعد', tone: 'neutral' },
};

// The exact provider signal for a row: Vapi's endedReason, falling back to any
// technical placement error. Shown verbatim so an operator sees the real cause
// (e.g. "customer-busy", "twilio-failed-to-connect") behind the mapped bucket.
const rawReason = (r) => r.endedReason || r.lastError || null;

const fmtDur = (s) => {
  const n = Number(s || 0);
  if (!n) return '—';
  const m = Math.floor(n / 60);
  return m ? `${m}:${String(n % 60).padStart(2, '0')}` : `${n}ث`;
};
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(String(v).replace(' ', 'T') + (String(v).endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ar-SA', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

export function CampaignReportPage({ companyId, campaign, onBack }) {
  const { push } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailRow, setDetailRow] = useState(null);
  const [filters, setFilters] = useState({
    lead: 'all', status: 'all', outcome: 'all', search: '', minDuration: '', from: '', to: '',
  });

  const load = useCallback(() => {
    if (!companyId || !campaign) return;
    setLoading(true);
    api.campaignReport(companyId, campaign.id, filters)
      .then(setData)
      .catch((e) => push(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [companyId, campaign, filters, push]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const s = data?.summary;
  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const filtersActive = useMemo(
    () => Object.entries(filters).some(([, v]) => v && v !== 'all'),
    [filters],
  );

  const exportCsv = () => {
    window.location.href = api.campaignReportCsvUrl(companyId, campaign.id, filters);
  };

  return (
    <div className="print:bg-white">
      {/* ── header ── */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-ink-100 print:static print:border-0">
        <div className="px-4 sm:px-8 py-4 flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 print:hidden">
            <ArrowRight className="w-3.5 h-3.5" /> الحملات
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] sm:text-[19px] font-semibold text-ink-900 truncate">
              تقرير حملة: {data?.campaign?.name || campaign?.name}
            </h1>
            <p className="text-[11.5px] text-ink-500 mt-0.5">
              {data?.campaign?.createdBy ? `أنشأها ${data.campaign.createdBy} · ` : ''}
              {data?.campaign?.startedAt ? `بدأت ${fmtDate(data.campaign.startedAt)}` : 'لم تبدأ بعد'}
              {data?.campaign?.completedAt ? ` · انتهت ${fmtDate(data.campaign.completedAt)}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1.5 print:hidden">
            <Button variant="secondary" size="sm" onClick={load} className="gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" /> تحديث
            </Button>
            <Button variant="secondary" size="sm" onClick={exportCsv} className="gap-1.5">
              <Download className="w-3.5 h-3.5" /> CSV / Excel
            </Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()} className="gap-1.5">
              <Printer className="w-3.5 h-3.5" /> PDF
            </Button>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-8 py-6 space-y-6">
        {/* ── overview ── */}
        <section>
          <SectionTitle>نظرة عامة</SectionTitle>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <Stat label="إجمالي العملاء" value={s?.totalContacts} />
            <Stat label="المكالمات المنفذة" value={s?.dialled} />
            <Stat label="ردّ العميل" value={s?.answered} tone="emerald" />
            <Stat label="لم يرد" value={s?.notAnswered} tone="ink" />
            <Stat label="نسبة الاتصال" value={s ? `${s.successRate}%` : null} tone="sky" />
            <Stat label="متوسط المدة" value={s ? fmtDur(s.avgDurationSec) : null} />
          </div>
        </section>

        {/* ── fixed KPI table (present in every campaign) ── */}
        <section>
          <SectionTitle>مؤشرات الحملة</SectionTitle>
          <KpiTable s={s} onPickOutcome={(o) => setF('outcome', filters.outcome === o ? 'all' : o)} activeOutcome={filters.outcome} />
        </section>

        {/* ── lead cards ── */}
        <section>
          <SectionTitle>تصنيف العملاء</SectionTitle>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <LeadCard k="hot"  n={s?.leads?.hot}  active={filters.lead === 'hot'}  onClick={() => setF('lead', filters.lead === 'hot' ? 'all' : 'hot')} />
            <LeadCard k="warm" n={s?.leads?.warm} active={filters.lead === 'warm'} onClick={() => setF('lead', filters.lead === 'warm' ? 'all' : 'warm')} />
            <LeadCard k="cold" n={s?.leads?.cold} active={filters.lead === 'cold'} onClick={() => setF('lead', filters.lead === 'cold' ? 'all' : 'cold')} />
            <CallbackCard n={s?.callbacks} active={filters.lead === 'callback'} onClick={() => setF('lead', filters.lead === 'callback' ? 'all' : 'callback')} />
            <LeadCard k="no_answer" n={s?.leads?.no_answer} active={filters.lead === 'no_answer'} onClick={() => setF('lead', filters.lead === 'no_answer' ? 'all' : 'no_answer')} />
            <div className="rounded-xl p-3 bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-card">
              <div className="flex items-center gap-1.5 text-[11px] opacity-90"><TrendingUp className="w-3.5 h-3.5" /> نسبة التحويل</div>
              <div className="text-[22px] font-bold tabular-nums mt-1">{s ? `${s.conversionRate}%` : '—'}</div>
              <div className="text-[10px] opacity-80">ساخن + دافئ من الذين ردّوا</div>
            </div>
          </div>
        </section>

        {/* ── filters ── */}
        <section className="print:hidden">
          <div className="bg-white border border-ink-100 rounded-2xl shadow-card p-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="lg:col-span-2">
                <Label>بحث</Label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-ink-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <Input value={filters.search} onChange={(e) => setF('search', e.target.value)}
                    placeholder="رقم الجوال، الاسم، أو نص الملخص" className="pr-9" />
                </div>
              </div>
              <div>
                <Label>التصنيف</Label>
                <Select value={filters.lead} onChange={(e) => setF('lead', e.target.value)}>
                  <option value="all">كل التصنيفات</option>
                  {Object.entries(LEAD_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                  <option value="callback">طلب معاودة اتصال</option>
                </Select>
              </div>
              <div>
                <Label>نتيجة المكالمة</Label>
                <Select value={filters.outcome} onChange={(e) => setF('outcome', e.target.value)}>
                  <option value="all">كل النتائج</option>
                  {Object.entries(OUTCOME_META).filter(([k]) => k !== 'pending').map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                </Select>
              </div>
              <div>
                <Label>أقل مدة (ثانية)</Label>
                <Input type="number" min={0} dir="ltr" value={filters.minDuration}
                  onChange={(e) => setF('minDuration', e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-3">
              <div><Label>من تاريخ</Label><Input type="date" dir="ltr" value={filters.from} onChange={(e) => setF('from', e.target.value)} /></div>
              <div><Label>إلى تاريخ</Label><Input type="date" dir="ltr" value={filters.to} onChange={(e) => setF('to', e.target.value)} /></div>
              <div className="flex items-end">
                {filtersActive && (
                  <Button variant="ghost" size="md" className="w-full"
                    onClick={() => setFilters({ lead: 'all', status: 'all', outcome: 'all', search: '', minDuration: '', from: '', to: '' })}>
                    مسح الفلاتر
                  </Button>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ── results ── */}
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <SectionTitle className="mb-0">النتائج التفصيلية</SectionTitle>
            <span className="text-[11.5px] text-ink-500 tabular-nums">
              {data ? `${data.filteredCount} من ${s?.totalContacts ?? 0}` : ''}
            </span>
          </div>

          {loading && !data ? (
            <div className="py-16 text-center text-[13px] text-ink-500">جارٍ تحميل التقرير…</div>
          ) : !data?.rows?.length ? (
            <div className="py-16 text-center">
              <FileText className="w-8 h-8 text-ink-300 mx-auto mb-2" />
              <p className="text-[13px] text-ink-600">{filtersActive ? 'لا نتائج مطابقة للفلاتر' : 'لا توجد أرقام في هذه الحملة'}</p>
            </div>
          ) : (
            <>
              {/* desktop table */}
              <div className="hidden lg:block bg-white border border-ink-100 rounded-2xl shadow-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="bg-ink-50/70 text-ink-600 text-[10.5px] uppercase tracking-wide">
                        <Th>العميل</Th><Th>نتيجة المكالمة</Th><Th>المدة</Th><Th>التصنيف</Th>
                        <Th>طلب العميل</Th><Th>الملخص</Th><Th>الإجراء التالي</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => {
                        const lm = LEAD_META[r.lead] || LEAD_META.pending;
                        const om = OUTCOME_META[r.outcome] || OUTCOME_META.pending;
                        return (
                          <tr key={r.id} onClick={() => setDetailRow(r)}
                            className="border-t border-ink-100 hover:bg-ink-50/50 cursor-pointer align-top">
                            <Td>
                              <div className="font-mono text-ink-900" dir="ltr">{r.phone}</div>
                              {r.name && <div className="text-[11px] text-ink-500">{r.name}</div>}
                            </Td>
                            <Td>
                              <Badge tone={om.tone}>{om.label}</Badge>
                              {rawReason(r) && (
                                <div className="text-[10px] text-ink-400 font-mono mt-1 max-w-[150px] truncate" dir="ltr" title={rawReason(r)}>
                                  {rawReason(r)}
                                </div>
                              )}
                            </Td>
                            <Td className="tabular-nums">{fmtDur(r.durationSec)}</Td>
                            <Td>
                              <div className="flex flex-col gap-1 items-start">
                                <Badge tone={lm.tone} dot>{lm.label}</Badge>
                                {r.callbackRequested && <Badge tone="brand">معاودة اتصال</Badge>}
                              </div>
                            </Td>
                            <Td className="max-w-[160px]"><span className="line-clamp-2 text-ink-700">{r.intent || '—'}</span></Td>
                            <Td className="max-w-[260px]"><span className="line-clamp-2 text-ink-600">{r.summary || '—'}</span></Td>
                            <Td className="max-w-[180px]"><span className="line-clamp-2 text-ink-700">{r.nextAction || '—'}</span></Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* mobile cards */}
              <div className="lg:hidden space-y-2">
                {data.rows.map((r) => {
                  const lm = LEAD_META[r.lead] || LEAD_META.pending;
                  const om = OUTCOME_META[r.outcome] || OUTCOME_META.pending;
                  return (
                    <button key={r.id} onClick={() => setDetailRow(r)}
                      className="w-full text-right bg-white border border-ink-100 rounded-2xl shadow-card p-3.5 focus-ring">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-[13px] text-ink-900" dir="ltr">{r.phone}</div>
                          {r.name && <div className="text-[11.5px] text-ink-500 truncate">{r.name}</div>}
                        </div>
                        <Badge tone={lm.tone} dot>{lm.label}</Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        <Badge tone={om.tone}>{om.label}</Badge>
                        <span className="text-[11px] text-ink-500 tabular-nums">{fmtDur(r.durationSec)}</span>
                        {r.callbackRequested && <Badge tone="brand">معاودة اتصال</Badge>}
                      </div>
                      {r.summary && <p className="mt-2 text-[11.5px] text-ink-600 line-clamp-2">{r.summary}</p>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>

      <ContactDetailModal row={detailRow} onClose={() => setDetailRow(null)} />
    </div>
  );
}

/* ── fixed KPI table — every metric present in every campaign ── */
// Rows mirror the agreed spec. `outcome` (when set) makes the row a live filter
// on the results table below; metric rows without one are pure totals.
const KPI_ROWS = [
  { label: 'عدد المكالمات المشغولة',       hint: 'الخط مشغول',                   get: (s) => s?.outcomes?.busy, outcome: 'busy' },
  { label: 'عدد الأرقام غير الصحيحة',      hint: 'رقم غير صالح أو خارج الخدمة',   get: (s) => s?.outcomes?.invalid, outcome: 'invalid' },
  { label: 'عدد الأرقام المغلقة',          hint: 'الجهاز مغلق أو خارج التغطية',   get: (s) => s?.outcomes?.switched_off, outcome: 'switched_off' },
  { label: 'عدد المكالمات المحولة لموظف',  hint: 'تم تحويلها لموظف بشري',         get: (s) => s?.outcomes?.transferred, outcome: 'transferred' },
  { label: 'عدد المكالمات المكتملة',       hint: 'أكمل العميل الحوار',           get: (s) => s?.outcomes?.completed, outcome: 'completed' },
  { label: 'عدد المكالمات المنتهية مبكراً', hint: 'أُغلق قبل إكمال السيناريو',    get: (s) => s?.outcomes?.ended_early, outcome: 'ended_early' },
  { label: 'معدل إكمال المكالمة',          hint: 'نسبة المكتملة من المكالمات المُجابة', get: (s) => s == null ? null : `${s.completionRate}%` },
];

function KpiTable({ s, onPickOutcome, activeOutcome }) {
  return (
    <div className="bg-white border border-ink-100 rounded-2xl shadow-card overflow-hidden">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="bg-ink-50/70 text-ink-600 text-[10.5px] uppercase tracking-wide">
            <th className="text-right font-medium px-4 py-2.5">المؤشر</th>
            <th className="text-right font-medium px-4 py-2.5 w-[42%]">الوصف</th>
            <th className="text-left font-medium px-4 py-2.5 w-[80px]">القيمة</th>
          </tr>
        </thead>
        <tbody>
          {KPI_ROWS.map((row) => {
            const clickable = !!row.outcome;
            const active = clickable && activeOutcome === row.outcome;
            const val = s ? row.get(s) : null;
            return (
              <tr key={row.label}
                onClick={clickable ? () => onPickOutcome(row.outcome) : undefined}
                aria-pressed={clickable ? active : undefined}
                className={`border-t border-ink-100 ${clickable ? 'cursor-pointer hover:bg-ink-50/60' : ''} ${active ? 'bg-brand-50' : ''}`}>
                <td className="px-4 py-2.5 font-medium text-ink-800">
                  {row.label}
                  {clickable && <span className="text-[9.5px] text-ink-400 mr-1.5 print:hidden">{active ? '· إلغاء' : '· تصفية'}</span>}
                </td>
                <td className="px-4 py-2.5 text-ink-500">{row.hint}</td>
                <td className={`px-4 py-2.5 text-left tabular-nums font-semibold ${row.warn && Number(val) > 0 ? 'text-rose-600' : 'text-ink-900'}`}>
                  {val ?? (val === 0 ? 0 : '—')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── pieces ── */
function SectionTitle({ children, className = '' }) {
  return <h2 className={`text-[13px] font-semibold text-ink-800 mb-2.5 ${className}`}>{children}</h2>;
}
function Th({ children }) {
  return <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">{children}</th>;
}
function Td({ children, className = '' }) {
  return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
}
function Select({ children, ...props }) {
  return (
    <select {...props}
      className="w-full h-9 px-3 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring">
      {children}
    </select>
  );
}
function Stat({ label, value, tone = 'ink' }) {
  const toneCls = { ink: 'text-ink-900', emerald: 'text-emerald-600', sky: 'text-sky-600' }[tone] || 'text-ink-900';
  return (
    <div className="bg-white border border-ink-100 rounded-xl shadow-card p-3">
      <div className="text-[11px] text-ink-500">{label}</div>
      <div className={`text-[20px] font-semibold tabular-nums mt-0.5 ${toneCls}`}>
        {value ?? value === 0 ? value : '—'}
      </div>
    </div>
  );
}
function LeadCard({ k, n, active, onClick }) {
  const m = LEAD_META[k];
  const Icon = m.icon;
  return (
    <button onClick={onClick}
      aria-pressed={active}
      className={`text-right rounded-xl p-3 shadow-card transition-all focus-ring bg-gradient-to-br ${m.card} text-white
        ${active ? 'ring-2 ring-offset-2 ring-ink-900 scale-[0.98]' : 'hover:brightness-110'}`}>
      <div className="flex items-center gap-1.5 text-[11px] opacity-90"><Icon className="w-3.5 h-3.5" /> {m.label}</div>
      <div className="text-[22px] font-bold tabular-nums mt-1">{n ?? '—'}</div>
      <div className="text-[10px] opacity-80">{active ? 'اضغط لإلغاء الفلتر' : 'اضغط للتصفية'}</div>
    </button>
  );
}
function CallbackCard({ n, active, onClick }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`text-right rounded-xl p-3 shadow-card transition-all focus-ring bg-gradient-to-br from-brand-500 to-brand-600 text-white
        ${active ? 'ring-2 ring-offset-2 ring-ink-900 scale-[0.98]' : 'hover:brightness-110'}`}>
      <div className="flex items-center gap-1.5 text-[11px] opacity-90"><PhoneForwarded className="w-3.5 h-3.5" /> طلب معاودة</div>
      <div className="text-[22px] font-bold tabular-nums mt-1">{n ?? '—'}</div>
      <div className="text-[10px] opacity-80">{active ? 'اضغط لإلغاء الفلتر' : 'اضغط للتصفية'}</div>
    </button>
  );
}

function ContactDetailModal({ row, onClose }) {
  if (!row) return null;
  const lm = LEAD_META[row.lead] || LEAD_META.pending;
  const om = OUTCOME_META[row.outcome] || OUTCOME_META.pending;
  return (
    <Modal open={!!row} onClose={onClose} size="lg" title={row.name || row.phone}
      description="تحليل المكالمة — مستخرج من تسجيل المكالمة نفسها."
      footer={<Button variant="ghost" onClick={onClose}>إغلاق</Button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={lm.tone} dot>{lm.label}</Badge>
          <Badge tone={om.tone}>{om.label}</Badge>
          {row.callbackRequested && <Badge tone="brand">طلب معاودة اتصال</Badge>}
          <span className="text-[11.5px] text-ink-500 tabular-nums">المدة {fmtDur(row.durationSec)}</span>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12.5px]">
          <Field label="رقم الجوال"><span className="font-mono" dir="ltr">{row.phone}</span></Field>
          <Field label="مستوى الاهتمام">{row.interestLevel || '—'}</Field>
          <Field label="نوع العقار">{row.propertyType || '—'}</Field>
          <Field label="المنطقة المفضلة">{row.preferredArea || '—'}</Field>
          <Field label="الميزانية">{row.budget || '—'}</Field>
          <Field label="عدد المحاولات">{row.attempts}</Field>
        </dl>

        {row.intent && <Block title="طلب العميل">{row.intent}</Block>}
        {row.summary && <Block title="ملخص المكالمة">{row.summary}</Block>}
        {row.notes && <Block title="ملاحظات">{row.notes}</Block>}
        {row.nextAction && row.nextAction !== '—' && (
          <div className="rounded-xl bg-brand-50 ring-1 ring-brand-200/60 p-3">
            <div className="text-[10.5px] font-medium text-brand-700 mb-0.5">الإجراء التالي</div>
            <p className="text-[12.5px] text-ink-800">{row.nextAction}</p>
          </div>
        )}
        {row.recordingUrl && (
          <a href={row.recordingUrl} target="_blank" rel="noreferrer"
            className="inline-block text-[12px] text-brand-600 hover:underline">استمع لتسجيل المكالمة ↗</a>
        )}
        {/* Raw provider signal — always shown when present, so the real reason a
            call ended/failed is never hidden behind the mapped bucket. */}
        {(row.endedReason || row.lastError) && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12.5px] pt-1 border-t border-ink-100">
            {row.endedReason && (
              <Field label="سبب الإنهاء (من المزوّد)">
                <span className="font-mono text-[11.5px]" dir="ltr">{row.endedReason}</span>
              </Field>
            )}
            {row.lastError && (
              <Field label="الخطأ الفني">
                <span className="font-mono text-[11.5px] text-rose-600" dir="ltr">{row.lastError}</span>
              </Field>
            )}
          </dl>
        )}
      </div>
    </Modal>
  );
}
function Field({ label, children }) {
  return (
    <div>
      <dt className="text-[10.5px] text-ink-500">{label}</dt>
      <dd className="text-ink-800 mt-0.5">{children}</dd>
    </div>
  );
}
function Block({ title, children }) {
  return (
    <div>
      <div className="text-[10.5px] font-medium text-ink-500 mb-1">{title}</div>
      <p className="text-[12.5px] text-ink-800 leading-relaxed bg-ink-50/60 rounded-xl p-3">{children}</p>
    </div>
  );
}
