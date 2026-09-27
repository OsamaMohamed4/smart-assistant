import { useEffect, useState } from 'react';
import { Zap, Check, AlertTriangle, Info } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { EmptyState } from '../components/ui/EmptyState';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { useToast } from '../components/ui/Toast';
import { cn } from '../lib/utils';
import { api } from '../lib/api';

// What each company's agent is allowed to do.
//
// Three states are shown, and conflating any two of them would mislead:
//
//   مفعّل        on, and its prerequisites are met — the agent gets the tool
//   متوقف        off by choice — refused server-side on every call, immediately
//   غير متاح بعد not built yet — cannot be switched on at all
//
// A fourth situation deserves its own treatment rather than a silent lie: a
// capability that is ON but cannot attach (no indexed documents, no transfer
// number). It stays switched on and explains what is missing, because showing
// it as "off" would be wrong and showing it as working would be worse.

function Toggle({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-ring',
        checked ? 'bg-ink-900' : 'bg-ink-200',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'inline-block h-4.5 w-4.5 h-[18px] w-[18px] transform rounded-full bg-white shadow transition-transform',
          checked ? '-translate-x-[22px]' : '-translate-x-1',
        )}
      />
    </button>
  );
}

function StateBadge({ f }) {
  if (f.status !== 'implemented') {
    return <span className="text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">غير متاح بعد</span>;
  }
  if (!f.enabled) {
    return <span className="text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-600">متوقف</span>;
  }
  if (f.available === false) {
    return <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">ينقصه إعداد</span>;
  }
  return <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">مفعّل</span>;
}

export function CapabilitiesPage({ pinnedCompanyId }) {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(pinnedCompanyId || null);
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState(null);

  useEffect(() => {
    if (pinnedCompanyId) { setCompanyId(pinnedCompanyId); return; }
    api.listCompanies().then((cs) => {
      setCompanies(cs || []);
      setCompanyId((curr) => curr || cs?.[0]?.id || null);
    }).catch((e) => push(e.message, 'error'));
  }, [pinnedCompanyId]);

  const load = (id) => {
    if (!id) return;
    setLoading(true);
    api.listFeatures(id)
      .then((r) => setFeatures(r.features || []))
      .catch((e) => push(e.message, 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { setFeatures([]); load(companyId); }, [companyId]);

  const onToggle = async (f, next) => {
    setBusyKey(f.key);
    try {
      const r = await api.setFeature(companyId, f.key, next);
      load(companyId);
      push(
        r.effectiveImmediately
          ? `تم إيقاف «${f.labelAr}» — يسري فوراً`
          : `تم تفعيل «${f.labelAr}» — انشر الشركة ليصل للوكيل`,
        'success',
      );
    } catch (e) {
      push(e.message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const activeCompany = companies.find((c) => c.id === companyId);
  const isWorkspace   = !!pinnedCompanyId;
  const implemented   = features.filter((f) => f.status === 'implemented');
  const planned       = features.filter((f) => f.status !== 'implemented');

  const row = (f) => (
    <div key={f.key} className="flex items-start gap-3 py-3.5 border-b border-ink-100 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px] font-medium text-ink-900">{f.labelAr}</span>
          <StateBadge f={f} />
        </div>
        <p className="text-[12.5px] text-ink-500 mt-0.5 leading-relaxed">{f.descriptionAr}</p>
        {f.status === 'implemented' && f.enabled && f.available === false && f.reason && (
          <p className="text-[12px] text-amber-700 mt-1.5 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
            {f.reason}
          </p>
        )}
      </div>
      <div className="pt-1">
        {f.status === 'implemented' ? (
          <Toggle
            checked={f.enabled}
            disabled={busyKey === f.key}
            onChange={(next) => onToggle(f, next)}
          />
        ) : (
          <span className="text-[11px] text-ink-400">قريباً</span>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <TopBar
        title="القدرات"
        subtitle={
          isWorkspace
            ? 'ما يُسمح للوكيل بتنفيذه أثناء المكالمة.'
            : (activeCompany ? `قدرات ${activeCompany.name}` : 'اختر شركة لعرض قدراتها.')
        }
        right={
          !isWorkspace && companies.length > 1 && (
            <select
              value={companyId || ''}
              onChange={(e) => setCompanyId(e.target.value)}
              className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring focus:border-ink-300"
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )
        }
      />

      <div className="px-8 py-7 max-w-3xl space-y-5">
        {!companyId ? (
          <EmptyState icon={Zap} title="لا توجد شركات" description="أنشئ شركة من تبويب الشركات أولاً." />
        ) : loading ? (
          <div className="text-[13px] text-ink-500">جارِ التحميل…</div>
        ) : (
          <>
            <div className="flex gap-2.5 rounded-xl border border-ink-200 bg-ink-50/60 px-4 py-3">
              <Info className="w-4 h-4 text-ink-500 shrink-0 mt-0.5" strokeWidth={2} />
              <p className="text-[12.5px] text-ink-600 leading-relaxed">
                إيقاف أي قدرة <strong className="text-ink-800">يسري فوراً</strong> — يرفضها الخادم في كل
                استدعاء حتى قبل إعادة النشر. أما التفعيل فيحتاج
                <strong className="text-ink-800"> نشر الشركة</strong> ليحصل الوكيل على الأداة.
              </p>
            </div>

            <Card>
              <CardHeader>
                <h3 className="text-[15px] font-semibold text-ink-900">قدرات متاحة</h3>
              </CardHeader>
              <CardBody className="py-1">{implemented.map(row)}</CardBody>
            </Card>

            {planned.length > 0 && (
              <Card>
                <CardHeader>
                  <h3 className="text-[15px] font-semibold text-ink-900">قيد التطوير</h3>
                  <p className="text-[12px] text-ink-500 mt-0.5">
                    معروضة للاطلاع فقط — لا يمكن تفعيلها، ولا تصل للوكيل.
                  </p>
                </CardHeader>
                <CardBody className="py-1 opacity-70">{planned.map(row)}</CardBody>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
