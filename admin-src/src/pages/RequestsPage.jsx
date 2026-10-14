import { useEffect, useState } from 'react';
import { Inbox, Phone, ChevronDown, ChevronUp } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { EmptyState } from '../components/ui/EmptyState';
import { Card } from '../components/ui/Card';
import { useToast } from '../components/ui/Toast';
import { cn, relTime } from '../lib/utils';
import { api } from '../lib/api';

// The requests the agent filed during calls, for the sales team to work.
//
// A request arrives as "جديد" and only a person moves it on — the client's
// requirements sheet (question 37) asks for changes to be stored for staff
// review rather than applied. The phone number comes from the call itself,
// never from the model, so an inbound call's number appears once that call's
// record has landed; a browser test never has one.

const STATUS_TONE = {
  new      : 'bg-brand-100 text-brand-800',
  in_review: 'bg-amber-100 text-amber-800',
  contacted: 'bg-emerald-100 text-emerald-800',
  closed   : 'bg-ink-100 text-ink-600',
};

function RequestRow({ r, statuses, onUpdate, busy }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(r.staffNotes || '');
  useEffect(() => { setNotes(r.staffNotes || ''); }, [r.staffNotes]);

  return (
    <div className="border-b border-ink-100 last:border-0">
      <div className="flex items-center gap-3 px-5 py-3.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-right flex items-center gap-3"
          aria-expanded={open}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[14px] font-medium text-ink-900 truncate">
                {r.customerName || 'بدون اسم'}
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-600">{r.typeLabel}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-[12px] text-ink-500">
              {r.customerPhone ? (
                <span className="inline-flex items-center gap-1" dir="ltr">
                  <Phone className="w-3 h-3" strokeWidth={2} />{r.customerPhone}
                </span>
              ) : (
                <span className="text-ink-400">لا يوجد رقم بعد</span>
              )}
              <span>{relTime(r.createdAt)}</span>
            </div>
          </div>
          {open
            ? <ChevronUp className="w-4 h-4 text-ink-400 shrink-0" />
            : <ChevronDown className="w-4 h-4 text-ink-400 shrink-0" />}
        </button>

        <select
          value={r.status}
          disabled={busy}
          onChange={(e) => onUpdate(r, { status: e.target.value })}
          className={cn(
            'h-8 px-2.5 rounded-lg text-[12px] font-medium border-0 focus-ring cursor-pointer',
            STATUS_TONE[r.status] || 'bg-ink-100 text-ink-600',
          )}
        >
          {Object.entries(statuses).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>

      {open && (
        <div className="px-5 pb-4 space-y-3">
          {r.fields.length ? (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-ink-50/70 px-4 py-3">
              {r.fields.map((f) => (
                <div key={f.key} className="min-w-0">
                  <dt className="text-[11.5px] text-ink-500">{f.label}</dt>
                  <dd className="text-[13px] text-ink-900 break-words">{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-[12.5px] text-ink-500">لم يُجمع أي حقل في هذا الطلب.</p>
          )}

          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-ink-700">ملاحظات الفريق</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full px-3 py-2 bg-white border border-ink-200 rounded-lg text-[13px] focus-ring resize-y"
            />
            <div className="flex justify-end">
              <button
                type="button"
                disabled={busy || notes === (r.staffNotes || '')}
                onClick={() => onUpdate(r, { staffNotes: notes })}
                className="h-8 px-3.5 rounded-lg bg-ink-900 text-white text-[12px] disabled:opacity-40"
              >
                حفظ الملاحظة
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function RequestsPage({ pinnedCompanyId }) {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(pinnedCompanyId || null);
  const [data, setData] = useState({ requests: [], statuses: {}, types: {} });
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (pinnedCompanyId) { setCompanyId(pinnedCompanyId); return; }
    api.listCompanies().then((cs) => {
      setCompanies(cs || []);
      setCompanyId((curr) => curr || cs?.[0]?.id || null);
    }).catch((e) => push(e.message, 'error'));
  }, [pinnedCompanyId]);

  const load = () => {
    if (!companyId) return;
    setLoading(true);
    api.listRequests(companyId, { status, type })
      .then(setData)
      .catch((e) => push(e.message, 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [companyId, status, type]);

  const onUpdate = async (r, body) => {
    setBusyId(r.id);
    try {
      await api.updateRequest(companyId, r.id, body);
      load();
    } catch (e) {
      push(e.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const isWorkspace = !!pinnedCompanyId;
  const active = companies.find((c) => c.id === companyId);
  const counts = data.requests.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});

  return (
    <div>
      <TopBar
        title="الطلبات"
        subtitle={
          isWorkspace
            ? 'طلبات سجّلها الوكيل أثناء المكالمات، لمتابعة فريق المبيعات.'
            : (active ? `طلبات ${active.name}` : 'اختر شركة لعرض طلباتها.')
        }
        right={
          !isWorkspace && companies.length > 1 && (
            <select
              value={companyId || ''}
              onChange={(e) => setCompanyId(e.target.value)}
              className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring"
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )
        }
      />

      <div className="px-8 py-7 max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 px-3 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring"
          >
            <option value="">كل الحالات</option>
            {Object.entries(data.statuses).map(([k, l]) => (
              <option key={k} value={k}>{l}{counts[k] && !status ? ` (${counts[k]})` : ''}</option>
            ))}
          </select>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-9 px-3 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring"
          >
            <option value="">كل الأنواع</option>
            {Object.entries(data.types).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>

        {!companyId ? (
          <EmptyState icon={Inbox} title="لا توجد شركات" description="أنشئ شركة من تبويب الشركات أولاً." />
        ) : loading && !data.requests.length ? (
          <div className="text-[13px] text-ink-500">جارِ التحميل…</div>
        ) : !data.requests.length ? (
          <EmptyState
            icon={Inbox}
            title="لا توجد طلبات"
            description="تظهر هنا الطلبات التي يسجّلها الوكيل بعد تفعيل قدرة «استقبال الطلبات» ونشر الشركة."
          />
        ) : (
          <Card className="overflow-hidden">
            {data.requests.map((r) => (
              <RequestRow key={r.id} r={r} statuses={data.statuses} onUpdate={onUpdate} busy={busyId === r.id} />
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
