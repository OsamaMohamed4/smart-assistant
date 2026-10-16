import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Phone, MessageCircle, Gauge } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { cn, fmtDuration, fmtNumber } from '../lib/utils';
import { api } from '../lib/api';

// Consumption per company for one month: inbound and outbound calls apart,
// with their talk time. Months are Saudi calendar months, cut server-side.
//
// A client sees only their own company. The provider's credits are platform
// cost rather than the client's business, so the server sends them to a
// superadmin only, and the column exists only when the data does.

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

// The last twelve Saudi months, newest first.
function recentMonths(count = 12, now = new Date()) {
  const local = new Date(now.getTime() + 3 * 3600 * 1000);
  let year = local.getUTCFullYear();
  let month = local.getUTCMonth();
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ value: `${year}-${String(month + 1).padStart(2, '0')}`, label: `${MONTHS_AR[month]} ${year}` });
    if (--month < 0) { month = 11; year--; }
  }
  return out;
}

const mmss = (sec) => fmtDuration(Math.round(Number(sec) || 0));
const fmtCredits = (v) => (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

function SummaryCard({ icon: Icon, label, calls, seconds, accent }) {
  const tone = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber  : 'bg-amber-50 text-amber-700',
    brand  : 'bg-brand-50 text-brand-700',
  }[accent];
  return (
    <div className="bg-white border border-ink-100 rounded-2xl p-5 shadow-card">
      <div className="flex items-center gap-3 mb-3">
        <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', tone)}>
          <Icon className="w-4 h-4" strokeWidth={2} />
        </div>
        <div className="text-[12.5px] text-ink-500 font-medium">{label}</div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[26px] font-bold text-ink-900 tabular-nums leading-none">{fmtNumber(calls)}</div>
          <div className="mt-1.5 text-[11px] text-ink-500">مكالمة</div>
        </div>
        <div className="text-left">
          <div className="text-[18px] font-semibold text-ink-800 tabular-nums leading-none" dir="ltr">{mmss(seconds)}</div>
          <div className="mt-1.5 text-[11px] text-ink-500">المدة (دقيقة:ثانية)</div>
        </div>
      </div>
    </div>
  );
}

// WhatsApp messages for the month: received from customers, answered by the
// assistant, templates sent after calls, and sends that did not go out.
// Before WhatsApp is linked at all, it says so instead of showing zeros that
// would read as "linked, and nothing happened".
const WA_COLUMNS = [
  { key: 'received',  label: 'رسائل واردة' },
  { key: 'replies',   label: 'ردود المساعد' },
  { key: 'templates', label: 'رسائل بعد المكالمة' },
  { key: 'failed',    label: 'لم تُرسل' },
];

function WhatsappUsage({ data, rows }) {
  const t = data?.totals?.whatsapp;
  return (
    <div className="rounded-2xl border border-ink-100 bg-white px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
          <MessageCircle className="w-4 h-4" strokeWidth={2} />
        </div>
        <div className="text-[13px] font-semibold text-ink-900">رسائل واتساب</div>
      </div>
      {!data ? null : !data.whatsappConnected ? (
        <p className="text-[12px] text-ink-500 mt-3">واتساب غير مربوط بالمنصة بعد، فلا يوجد استهلاك رسائل لعرضه.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            {WA_COLUMNS.map((c) => (
              <div key={c.key} className="rounded-xl bg-ink-50/60 px-4 py-3">
                <div className={cn('text-[22px] font-bold tabular-nums leading-none', c.key === 'failed' && t?.failed ? 'text-rose-600' : 'text-ink-900')}>
                  {fmtNumber(t?.[c.key] || 0)}
                </div>
                <div className="mt-1.5 text-[11px] text-ink-500">{c.label}</div>
              </div>
            ))}
          </div>
          {rows.length > 1 && (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-[13px] whitespace-nowrap">
                <thead>
                  <tr className="text-[11.5px] text-ink-500">
                    <th className="text-right font-medium py-2 pl-4">الشركة</th>
                    {WA_COLUMNS.map((c) => <th key={c.key} className="text-right font-medium py-2 px-3">{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.companyId} className="border-t border-ink-100">
                      <td className="py-2.5 pl-4 font-medium text-ink-900">{r.companyName}</td>
                      {WA_COLUMNS.map((c) => <td key={c.key} className="py-2.5 px-3 tabular-nums">{fmtNumber(r.whatsapp?.[c.key] || 0)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function UsagePage({ pinnedCompanyId }) {
  const { push } = useToast();
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[0].value);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.usage({ month, companyId: pinnedCompanyId || undefined })
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) push(e.message, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, pinnedCompanyId]);

  const rows = data?.rows || [];
  const totals = data?.totals;
  const showCredits = !!totals?.credits;
  const both = (t) => ({
    calls  : (t?.inbound?.calls || 0) + (t?.outbound?.calls || 0),
    seconds: (t?.inbound?.seconds || 0) + (t?.outbound?.seconds || 0),
  });
  const all = both(totals);

  return (
    <div>
      <TopBar
        title="الاستهلاك"
        subtitle="المكالمات الواردة والصادرة ومدتها، ورسائل واتساب، لكل شهر بتوقيت السعودية."
        right={(
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring"
          >
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        )}
      />

      <div className="px-8 py-7 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SummaryCard icon={ArrowDownLeft} label="المكالمات الواردة" accent="emerald"
            calls={totals?.inbound?.calls || 0} seconds={totals?.inbound?.seconds || 0} />
          <SummaryCard icon={ArrowUpRight} label="المكالمات الصادرة" accent="amber"
            calls={totals?.outbound?.calls || 0} seconds={totals?.outbound?.seconds || 0} />
          <SummaryCard icon={Phone} label="الإجمالي" accent="brand" calls={all.calls} seconds={all.seconds} />
        </div>

        {/* One company needs no table: the cards above are its whole report. */}
        {rows.length > 1 && (
          <Card className="overflow-x-auto">
            <table className="w-full text-[13px] whitespace-nowrap">
              <thead>
                <tr className="bg-ink-50/80 text-[11.5px] text-ink-500">
                  <th className="text-right font-medium px-5 py-3">الشركة</th>
                  <th className="text-right font-medium px-4 py-3">واردة</th>
                  <th className="text-right font-medium px-4 py-3">مدة الواردة</th>
                  <th className="text-right font-medium px-4 py-3">صادرة</th>
                  <th className="text-right font-medium px-4 py-3">مدة الصادرة</th>
                  <th className="text-right font-medium px-4 py-3">المدة الإجمالية</th>
                  {showCredits && <th className="text-right font-medium px-4 py-3">كريدت المزوّد</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const sum = both(r);
                  return (
                    <tr key={r.companyId} className={cn('border-t border-ink-100', !sum.calls && 'text-ink-400')}>
                      <td className="px-5 py-3 font-medium text-ink-900">{r.companyName}</td>
                      <td className="px-4 py-3 tabular-nums">{fmtNumber(r.inbound.calls)}</td>
                      <td className="px-4 py-3 tabular-nums" dir="ltr">{mmss(r.inbound.seconds)}</td>
                      <td className="px-4 py-3 tabular-nums">{fmtNumber(r.outbound.calls)}</td>
                      <td className="px-4 py-3 tabular-nums" dir="ltr">{mmss(r.outbound.seconds)}</td>
                      <td className="px-4 py-3 tabular-nums font-semibold" dir="ltr">{mmss(sum.seconds)}</td>
                      {showCredits && (
                        <td className="px-4 py-3 tabular-nums" dir="ltr">
                          {fmtCredits(r.credits.inbound + r.credits.outbound)}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-200 bg-ink-50/50 font-semibold text-ink-900">
                  <td className="px-5 py-3">الإجمالي</td>
                  <td className="px-4 py-3 tabular-nums">{fmtNumber(totals.inbound.calls)}</td>
                  <td className="px-4 py-3 tabular-nums" dir="ltr">{mmss(totals.inbound.seconds)}</td>
                  <td className="px-4 py-3 tabular-nums">{fmtNumber(totals.outbound.calls)}</td>
                  <td className="px-4 py-3 tabular-nums" dir="ltr">{mmss(totals.outbound.seconds)}</td>
                  <td className="px-4 py-3 tabular-nums" dir="ltr">{mmss(all.seconds)}</td>
                  {showCredits && (
                    <td className="px-4 py-3 tabular-nums" dir="ltr">
                      {fmtCredits(totals.credits.inbound + totals.credits.outbound)}
                    </td>
                  )}
                </tr>
              </tfoot>
            </table>
          </Card>
        )}

        {!loading && !rows.length && (
          <EmptyState icon={Gauge} title="لا توجد شركات" description="أنشئ شركة من تبويب الشركات أولاً." />
        )}

        <WhatsappUsage data={data} rows={rows} />


        <p className="text-[11.5px] text-ink-400 leading-relaxed">
          المدة هي مجموع مدة المكالمات الفعلية. المكالمة الصادرة التي لم يُرد عليها تُحسب مكالمة بمدة صفر.
        </p>
      </div>
    </div>
  );
}
