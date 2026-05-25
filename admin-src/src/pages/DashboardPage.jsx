import { useEffect, useMemo, useState } from 'react';
import {
  Phone, Clock, CheckCircle2, ArrowDownLeft, ArrowUpRight, Sparkles, Building2,
  TrendingUp, TrendingDown, Minus,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { TopBar } from '../components/layout/TopBar';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtNumber } from '../lib/utils';

const PERIODS = [
  { id: 'today',   label: 'اليوم' },
  { id: 'week',    label: 'هذا الأسبوع' },
  { id: 'month',   label: 'هذا الشهر' },
  { id: 'quarter', label: 'هذا الربع' },
];

export function DashboardPage() {
  const { push } = useToast();
  const [period, setPeriod]       = useState('today');
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('all');
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);

  // Load companies once for the filter dropdown. We tolerate failure here —
  // the dashboard still works without the dropdown, just defaults to all.
  useEffect(() => {
    api.listCompanies()
      .then((cs) => setCompanies(cs || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.dashboard({ period, companyId: companyId === 'all' ? undefined : companyId })
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) push(e.message, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, companyId]);

  const totals = data?.current  || { calls: 0, avgDur: 0, success: 0, chats: 0 };
  const prev   = data?.previous || { calls: 0, avgDur: 0, success: 0, chats: 0 };

  // Compose chart data into per-hour rows. We translate the keys for the
  // Recharts tooltip so the demo reads cleanly in Arabic.
  const chartData = useMemo(() => (data?.chart || []).map((r) => ({
    ساعة      : r.hour,
    'واردة'   : r.inbound,
    'صادرة'   : r.outbound,
    'شات'     : r.chats,
  })), [data]);

  return (
    <div>
      <TopBar
        title="لوحة التحكم"
        subtitle="نظرة شاملة على نشاط المساعد الذكي"
        right={(
          <div className="flex items-center gap-2">
            {companies.length > 1 && (
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring focus:border-ink-300"
              >
                <option value="all">كل الشركات</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
      />

      <div className="px-8 py-7">
        {/* ─── Period segmented control ─── */}
        <div className="flex items-center justify-end mb-6">
          <div className="flex items-center gap-1 bg-white border border-ink-200 rounded-2xl p-1">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={cn(
                  'h-8 px-4 rounded-xl text-[12.5px] font-medium transition-all',
                  period === p.id
                    ? 'bg-brand-500 text-white shadow-soft'
                    : 'text-ink-600 hover:text-ink-900',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Top metric cards ─── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-7">
          <MetricCard
            icon={Phone}
            label="إجمالي المكالمات"
            value={fmtNumber(totals.calls)}
            sub="اليوم مقابل أمس"
            delta={pct(totals.calls, prev.calls)}
            accent="brand"
            loading={loading}
          />
          <MetricCard
            icon={Clock}
            label="متوسط المدة"
            value={fmtDuration(totals.avgDur)}
            sub="اليوم مقابل أمس"
            delta={pct(totals.avgDur, prev.avgDur)}
            accent="sky"
            loading={loading}
          />
          <MetricCard
            icon={CheckCircle2}
            label="نسبة النجاح"
            value={`${Math.round(totals.success * 100)}%`}
            sub="اليوم مقابل أمس"
            delta={pct(totals.success, prev.success)}
            accent="emerald"
            loading={loading}
          />
        </div>

        {/* ─── Call analytics secondary row ─── */}
        <div className="mb-5">
          <h2 className="text-[14px] font-semibold text-ink-900 mb-3">تحليلات المكالمات</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MiniStat
              icon={ArrowDownLeft}
              label="مكالمات واردة"
              value={fmtNumber(totals.calls)}
              hint="مكالمات من العملاء"
              accent="emerald"
            />
            <MiniStat
              icon={ArrowUpRight}
              label="مكالمات صادرة"
              value="0"
              hint="قريباً — حملات outbound"
              accent="amber"
              dimmed
            />
            <MiniStat
              icon={Sparkles}
              label="سيناريوهات"
              value={fmtNumber(data?.scenarios || 0)}
              hint="شركات نشطة"
              accent="violet"
            />
          </div>
        </div>

        {/* ─── Chart ─── */}
        <div className="bg-white border border-ink-100 rounded-2xl p-5 shadow-card">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-[14px] font-semibold text-ink-900">واردة مقابل صادرة</h3>
              <p className="text-[11.5px] text-ink-500 mt-0.5">توزيع المكالمات والشات على ساعات اليوم</p>
            </div>
            {loading && <div className="text-[11px] text-ink-400">يحدّث...</div>}
          </div>

          <div className="h-72">
            {chartData.every((d) => d['واردة'] + d['صادرة'] + d['شات'] === 0) ? (
              <ChartEmpty />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f1f4" />
                  <XAxis dataKey="ساعة" tick={{ fontSize: 11, fill: '#7c7c89' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#7c7c89' }} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 12, border: '1px solid #ebebef',
                      fontSize: 12, padding: '8px 10px',
                    }}
                    labelStyle={{ color: '#1a1a24', fontWeight: 600 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="واردة"  stroke="#10b981" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                  <Line type="monotone" dataKey="صادرة"  stroke="#f59e0b" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                  <Line type="monotone" dataKey="شات"   stroke="#5b5bd6" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Components ───────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, sub, delta, accent = 'brand', loading }) {
  const colors = {
    brand   : 'bg-brand-50 text-brand-700',
    emerald : 'bg-emerald-50 text-emerald-700',
    sky     : 'bg-sky-50 text-sky-700',
    violet  : 'bg-violet-50 text-violet-700',
  }[accent];
  return (
    <div className="bg-white border border-ink-100 rounded-2xl p-5 shadow-card relative overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', colors)}>
          <Icon className="w-4 h-4" strokeWidth={2} />
        </div>
        <DeltaPill delta={delta} />
      </div>
      <div className="text-[12px] text-ink-500 font-medium">{label}</div>
      <div className="mt-1 text-[28px] font-bold text-ink-900 tabular-nums tracking-tight leading-none">
        {loading ? <span className="shimmer inline-block w-20 h-7 rounded" /> : value}
      </div>
      <div className="mt-2 text-[11px] text-ink-500">{sub}</div>
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, hint, accent, dimmed }) {
  const colors = {
    emerald : 'bg-emerald-50 text-emerald-700',
    amber   : 'bg-amber-50 text-amber-700',
    violet  : 'bg-violet-50 text-violet-700',
  }[accent];
  return (
    <div className={cn(
      'bg-white border border-ink-100 rounded-2xl p-4 shadow-card flex items-center gap-3',
      dimmed && 'opacity-70',
    )}>
      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', colors)}>
        <Icon className="w-4 h-4" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11.5px] text-ink-500 font-medium">{label}</div>
        <div className="mt-0.5 text-[20px] font-bold text-ink-900 tabular-nums leading-none">{value}</div>
        <div className="mt-1 text-[10.5px] text-ink-400 truncate">{hint}</div>
      </div>
    </div>
  );
}

function DeltaPill({ delta }) {
  // delta is a number representing percent change (e.g., 0.23 = +23%)
  if (delta === null || !isFinite(delta)) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-400 bg-ink-50 px-2 py-0.5 rounded-full">
        <Minus className="w-2.5 h-2.5" /> —
      </span>
    );
  }
  const positive = delta > 0;
  const neutral  = Math.abs(delta) < 0.01;
  if (neutral) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-500 bg-ink-50 px-2 py-0.5 rounded-full">
        <Minus className="w-2.5 h-2.5" /> 0%
      </span>
    );
  }
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full',
      positive
        ? 'bg-emerald-50 text-emerald-700'
        : 'bg-rose-50 text-rose-700',
    )}>
      {positive
        ? <TrendingUp className="w-2.5 h-2.5" />
        : <TrendingDown className="w-2.5 h-2.5" />}
      {positive ? '+' : ''}{Math.round(delta * 100)}%
    </span>
  );
}

function ChartEmpty() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center">
      <div className="w-12 h-12 rounded-2xl bg-ink-50 text-ink-400 flex items-center justify-center mb-3">
        <Building2 className="w-5 h-5" />
      </div>
      <div className="text-[13px] font-semibold text-ink-700">ما فيه نشاط في الفترة دي</div>
      <p className="text-[11.5px] text-ink-500 mt-1 max-w-xs">
        لما العملاء يبدأوا يكلموا المساعد، الرسم البياني هيتعبأ هنا تلقائياً.
      </p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

function pct(curr, previous) {
  if (!previous && !curr)      return 0;
  if (!previous)               return null;  // no baseline → show "—"
  return (curr - previous) / previous;
}

function fmtDuration(sec) {
  if (!sec || sec < 1) return '0m 0s';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}
