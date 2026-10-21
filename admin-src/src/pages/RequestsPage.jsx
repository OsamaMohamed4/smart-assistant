import { useEffect, useState } from 'react';
import { Inbox, Phone, ChevronDown, ChevronUp } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { EmptyState } from '../components/ui/EmptyState';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
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

// What became of sending a request on to the company's Estate.
const ESTATE_TONE = {
  sent   : 'text-emerald-700',
  pending: 'text-sky-700',
  failed : 'text-rose-700',
  skipped: 'text-amber-800',
};
function estateLine(e) {
  if (e.status === 'sent') return 'أُرسل إلى Estate';
  if (e.status === 'pending') return 'قيد الإرسال إلى Estate';
  if (e.status === 'failed') return `لم يُرسل إلى Estate: ${e.detail || 'سبب غير معروف'}`;
  return e.detail || 'لم يُرسل إلى Estate';
}

function RequestRow({ r, statuses, onUpdate, busy, canSendToEstate, onSendToEstate }) {
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
            {r.estate && (
              <div className={cn('mt-0.5 text-[11.5px]', ESTATE_TONE[r.estate.status] || 'text-ink-500')}>{estateLine(r.estate)}</div>
            )}
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
            <div className="flex justify-end gap-2">
              {canSendToEstate && (!r.estate || ['failed', 'skipped'].includes(r.estate.status)) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSendToEstate(r)}
                  className="h-8 px-3.5 rounded-lg border border-ink-200 bg-white text-ink-800 text-[12px] disabled:opacity-40"
                >
                  {r.estate ? 'إعادة الإرسال إلى Estate' : 'إرسال إلى Estate'}
                </button>
              )}
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

export function RequestsPage({ user, pinnedCompanyId }) {
  const isSuper = user?.role === 'superadmin';
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

  const onSendToEstate = async (r) => {
    setBusyId(r.id);
    try {
      const out = await api.sendRequestToEstate(companyId, r.id);
      if (out.sent) push('أُرسل الطلب إلى Estate', 'success');
      else push(out.failed ? `لم يقبله Estate: ${out.failed}` : (out.skipped || 'لم يُرسل'), 'error');
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
        {isSuper && companyId && <EstateCard key={companyId} companyId={companyId} onChange={load} />}

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
              <RequestRow key={r.id} r={r} statuses={data.statuses} onUpdate={onUpdate} busy={busyId === r.id}
                canSendToEstate={isSuper && data.estateReady} onSendToEstate={onSendToEstate} />
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

// The company's own Estate (its ERP), superadmin only. Its API key is
// write-only: the screen only learns whether one is saved. Nothing is sent
// until it is switched on, and "فحص الاتصال" asks Estate which fields it
// enforces before any real request goes. See services/estate.js.
function EstateCard({ companyId, onChange }) {
  const { push } = useToast();
  const [s, setS] = useState(null);
  const [form, setForm] = useState({ url: '', platform: '', enabled: false, projects: '' });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [check, setCheck] = useState(null);
  const [open, setOpen] = useState(false);

  // `resetForm` false keeps what is being typed (saving the key mid-edit).
  const load = (resetForm = true) => api.companyEstate(companyId).then((r) => {
    setS(r);
    if (resetForm) {
      setForm({
        url: r.url || '', platform: r.platform || '', enabled: !!r.enabled,
        projects: (r.projects || []).map((p) => `${p.name} = ${p.code}`).join('\n'),
      });
      if (!r.enabled) setOpen(true);
    } else if (!r.hasToken) {
      setForm((f) => ({ ...f, enabled: false }));
    }
  }).catch((e) => push(e.message, 'error'));
  useEffect(() => { load(); }, [companyId]);

  const run = async (what, fn) => {
    setBusy(what);
    try { await fn(); } catch (e) { push(e.message, 'error'); } finally { setBusy(''); }
  };
  const save = () => run('save', async () => {
    await api.saveCompanyEstate(companyId, form);
    push('تم حفظ إعدادات Estate', 'success');
    await load(); onChange?.();
  });
  const saveToken = (value) => run('token', async () => {
    const r = await api.saveCompanyEstateToken(companyId, value);
    setToken('');
    push(r.hasToken ? 'تم حفظ مفتاح Estate' : 'أُزيل مفتاح Estate، وأُوقف الإرسال', 'success');
    await load(false); onChange?.();
  });
  const runCheck = () => run('check', async () => {
    setCheck(await api.checkCompanyEstate(companyId, form.url));
  });

  if (!s) return null;
  const input = 'w-full h-10 px-3 rounded-xl border border-ink-200 bg-white text-[13px] focus-ring';
  return (
    <Card className="p-5 space-y-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between gap-3 text-right">
        <span className="text-[14px] font-semibold text-ink-900">ربط Estate</span>
        <span className="flex items-center gap-2">
          <span className={cn('text-[12px] font-medium', s.enabled ? 'text-emerald-700' : 'text-ink-500')}>
            {s.enabled ? 'يعمل: تُرسل طلبات الاهتمام بعد كل مكالمة' : 'غير مفعّل'}
          </span>
          {open ? <ChevronUp className="w-4 h-4 text-ink-400" /> : <ChevronDown className="w-4 h-4 text-ink-400" />}
        </span>
      </button>

      {open && (
        <>
          <p className="text-[12px] text-ink-500 leading-relaxed">
            يُرسل كل «طلب اهتمام» يسجّله الوكيل إلى نظام Estate الخاص بالشركة بعد انتهاء المكالمة: اسم العميل، ورقمه من المكالمة، والمشروع المهتم به برمزه، وملاحظة فيها كل إجابات العميل.
            مهير ووكن على Estate واحد: العنوان نفسه والمفتاح نفسه، ويُميَّز الطلب برمز المشروع.
            طلبات التأجير لا تُرسل، فلها في Estate واجهة أخرى. ويظهر بجانب كل طلب ما جرى له.
          </p>

          <div>
            <label className="block text-[12px] font-medium text-ink-700 mb-1">عنوان Estate الخاص بالشركة</label>
            <input dir="ltr" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://maher.e-statee.com" className={cn(input, 'font-mono text-[12px]')} />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-1">
              <label className="block text-[12px] font-medium text-ink-700">مفتاح Estate (API)</label>
              <span className={cn('text-[11.5px] font-semibold', s.hasToken ? 'text-emerald-700' : 'text-ink-500')}>
                {s.hasToken ? 'المفتاح محفوظ' : 'لا يوجد مفتاح'}
              </span>
            </div>
            <div className="flex gap-2">
              <input type="password" autoComplete="off" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder={s.hasToken ? 'لاستبدال المفتاح، الصق مفتاحاً جديداً' : 'الصق المفتاح الذي أعطاك إياه Estate'}
                className={cn(input, 'flex-1 font-mono text-[12px]')} />
              <Button variant="secondary" disabled={!token.trim()} loading={busy === 'token'} onClick={() => saveToken(token.trim())}>حفظ المفتاح</Button>
            </div>
            <p className="mt-1 text-[11.5px] text-ink-500">لا يُعرض بعد الحفظ، ولا يصل إلى المتصفح.</p>
            {s.hasToken && (
              <button type="button" className="mt-1 text-[11.5px] text-rose-700 underline disabled:opacity-50" disabled={!!busy}
                onClick={() => saveToken('')}>إزالة المفتاح</button>
            )}
          </div>

          <div>
            <label className="block text-[12px] font-medium text-ink-700 mb-1">قيمة المصدر (platform)</label>
            <input dir="ltr" value={form.platform} maxLength={60} onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))}
              className={cn(input, 'font-mono text-[12px]')} />
            <p className="mt-1 text-[11.5px] text-ink-500">القيمة التي اعتمدها Estate لطلبات المساعد الذكي هي <span dir="ltr" className="font-mono">ai_chat</span>، وتُستخدم إن تُرك الحقل فارغاً.</p>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-ink-700 mb-1">مشاريع الشركة ورموزها في Estate</label>
            <textarea dir="auto" rows={6} value={form.projects} onChange={(e) => setForm((f) => ({ ...f, projects: e.target.value }))}
              placeholder={'M-10 — أدوار، حي المغرزات = M-10\nوكن 038 — فلل، حي النهضة = W-38'}
              className="w-full px-3 py-2 rounded-xl border border-ink-200 bg-white text-[12.5px] leading-relaxed focus-ring resize-y" />
            <p className="mt-1 text-[11.5px] text-ink-500 leading-relaxed">
              سطر لكل مشروع: الاسم كما يعرضه الوكيل على العميل، ثم «=»، ثم رمز المشروع في Estate.
              يختار الوكيل المشروع من هذه الأسماء فقط، ويُرسل رمزه مع الطلب. بعد تعديل القائمة اضغط «نشر» للشركة حتى تصل إلى الوكيل.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-ink-100 px-4 py-3 cursor-pointer">
            <input type="checkbox" className="mt-1 w-4 h-4 accent-brand-600" checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
            <span>
              <span className="block text-[13px] font-medium text-ink-900">إرسال طلبات الاهتمام إلى Estate بعد كل مكالمة</span>
              <span className="block text-[12px] text-ink-500 mt-0.5">يحتاج العنوان والمفتاح.</span>
            </span>
          </label>

          {check && (
            <div className={cn('rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed',
              check.ok ? (check.warn ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-emerald-50 border-emerald-200 text-emerald-800') : 'bg-rose-50 border-rose-200 text-rose-800')}>
              {check.text}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={!s.hasToken || !form.url.trim()} loading={busy === 'check'} onClick={runCheck}>فحص الاتصال</Button>
            <Button variant="brand" loading={busy === 'save'} onClick={save}>حفظ</Button>
          </div>
          <p className="text-[11.5px] text-ink-500 leading-relaxed">
            «فحص الاتصال» يرسل إلى Estate طلباً بلا بيانات، والمتوقع أن يرفضه ويذكر الحقول التي يشترطها. وإن قبله، فستظهر رسالة تطلب حذفه من Estate.
          </p>
        </>
      )}
    </Card>
  );
}
