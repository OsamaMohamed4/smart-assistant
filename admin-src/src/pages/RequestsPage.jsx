import { useEffect, useState } from 'react';
import { Inbox, Phone, MessageCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { EmptyState } from '../components/ui/EmptyState';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { cn, relTime } from '../lib/utils';
import { api } from '../lib/api';

// The requests the agent filed during calls and WhatsApp conversations, for
// the sales team to work.
//
// A request arrives as "جديد" and only a person moves it on — the client's
// requirements sheet (question 37) asks for changes to be stored for staff
// review rather than applied. The phone number comes from the call itself (or
// the WhatsApp number), never from the model, so an inbound call's number
// appears once that call's record has landed; a browser test never has one.

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
  if (e.status === 'sent') return e.detail ? `أُرسل إلى Estate، وردّ: ${e.detail}` : 'أُرسل إلى Estate';
  if (e.status === 'pending') return 'قيد الإرسال إلى Estate';
  if (e.status === 'failed') return `لم يُرسل إلى Estate: ${e.detail || 'سبب غير معروف'}`;
  return e.detail || 'لم يُرسل إلى Estate';
}

// A request as sent to Estate, as a curl command Postman imports (Import →
// Raw text). The keys are never in the trace: placeholders stand where they go.
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function curlOf(a) {
  const headers = a.as === 'form'
    ? ['api-key: <مفتاح الاهتمام>', 'Authorization: Bearer <مفتاح الاهتمام>', 'Accept: application/json', 'Content-Type: application/x-www-form-urlencoded']
    : ['x-api-key: <مفتاح النظام>', 'x-secret-key: <المفتاح السري>', 'X-Requested-With: XMLHttpRequest', 'Accept: application/json'];
  const flag = a.as === 'form' ? '--data-urlencode' : '-F';
  return [
    `curl -X POST ${shellQuote(a.url)}`,
    ...headers.map((h) => `  -H ${shellQuote(h)}`),
    ...a.fields.map(([k, v]) => `  ${flag} ${shellQuote(`${k}=${v}`)}`),
  ].join(' \\\n');
}
// The fields as JSON; a repeated key (how_hear_about_us[]) keeps all its values.
function fieldsJson(fields) {
  const out = {};
  for (const [k, v] of fields) out[k] = k in out ? [].concat(out[k], v) : v;
  return JSON.stringify(out, null, 2);
}
const answerText = (a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2));

function EstateTrace({ companyId, requestId }) {
  const { push } = useToast();
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    api.requestEstateTrace(companyId, requestId)
      .then((r) => live && setState({ trace: r.trace }))
      .catch((e) => live && setState({ error: e.message }));
    return () => { live = false; };
  }, [companyId, requestId]);
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => push(`تم نسخ ${what}`, 'success'), () => {});

  if (state.loading) return <p className="text-[12px] text-ink-500">جارِ التحميل…</p>;
  if (state.error) return <p className="text-[12px] text-rose-700">{state.error}</p>;
  const t = state.trace;
  if (!t) return <p className="text-[12px] text-ink-500">لم يُرسل هذا الطلب إلى Estate بعد.</p>;
  if (t.skip) return <p className="text-[12px] text-amber-800">{t.skip}</p>;
  return (
    <div className="space-y-3">
      <p className="text-[11.5px] text-ink-500 leading-relaxed">
        {t.rebuilt
          ? 'لم تُحفظ تفاصيل إرسال هذا الطلب لأنه أُرسل قبل حفظها. هذا ما يُبنى منه الآن بالإعدادات الحالية، وهو نفسه ما أُرسل ما لم تتغير الإعدادات بعده.'
          : `هذا ما أُرسل فعلاً إلى Estate${t.at ? ` (${relTime(t.at)})` : ''}، وما ردّ به.`}
        {' '}المفاتيح لا تُحفظ هنا: في الأمر المنسوخ مكانها بين {'< >'}، فضعها قبل التجربة في Postman (Import ثم Raw text). والتجربة تُنشئ طلباً حقيقياً في Estate.
      </p>
      {t.attempts.length > 1 && (
        <p className="text-[11.5px] text-ink-500">لهذا الطلب أكثر من صيغة: تُرسل الأولى، ولا تُرسل التالية إلا إذا رفض Estate السابقة (422).</p>
      )}
      {t.attempts.map((a, i) => (
        <div key={i} className="rounded-xl border border-ink-100 p-3 space-y-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="font-medium text-ink-800">{t.attempts.length > 1 ? `الصيغة ${i + 1}` : 'الطلب'}</span>
            {a.status != null && (
              <span className={cn('px-2 py-0.5 rounded-full', a.status >= 200 && a.status < 300 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')} dir="ltr">
                HTTP {a.status}
              </span>
            )}
            <span className="text-ink-500 truncate min-w-0" dir="ltr">{a.url}</span>
          </div>
          <pre dir="ltr" className="text-[11.5px] bg-ink-50 rounded-lg p-2.5 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">{fieldsJson(a.fields)}</pre>
          {'answer' in a && (
            <>
              <div className="text-[11.5px] text-ink-500">ردّ Estate</div>
              <pre dir="ltr" className="text-[11.5px] bg-ink-50 rounded-lg p-2.5 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">{a.answer == null ? '—' : answerText(a.answer)}</pre>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => copy(curlOf(a), 'الأمر')}
              className="h-7 px-3 rounded-lg border border-ink-200 bg-white text-ink-800 text-[11.5px]">نسخ كأمر curl لـ Postman</button>
            <button type="button" onClick={() => copy(fieldsJson(a.fields), 'الحقول')}
              className="h-7 px-3 rounded-lg border border-ink-200 bg-white text-ink-800 text-[11.5px]">نسخ الحقول JSON</button>
          </div>
        </div>
      ))}
      {t.error && <p className="text-[12px] text-rose-700">{t.error}</p>}
    </div>
  );
}

function RequestRow({ r, statuses, onUpdate, busy, canSendToEstate, onSendToEstate, canSeeEstate, companyId }) {
  const [open, setOpen] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
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
              {r.channel === 'whatsapp' && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">واتساب</span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-[12px] text-ink-500">
              {r.customerPhone ? (
                <span className="inline-flex items-center gap-1" dir="ltr">
                  {r.channel === 'whatsapp'
                    ? <MessageCircle className="w-3 h-3" strokeWidth={2} />
                    : <Phone className="w-3 h-3" strokeWidth={2} />}
                  {r.customerPhone}
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

          {canSeeEstate && r.estate && (
            <div className="space-y-2">
              <button type="button" onClick={() => setShowTrace((v) => !v)}
                className="text-[12px] text-brand-700 hover:underline" aria-expanded={showTrace}>
                {showTrace ? 'إخفاء ما أُرسل إلى Estate' : 'عرض ما أُرسل إلى Estate وردّه'}
              </button>
              {showTrace && <EstateTrace key={`${r.estate.status}-${r.estate.at}`} companyId={companyId} requestId={r.id} />}
            </div>
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
                canSendToEstate={isSuper && data.estateReady} onSendToEstate={onSendToEstate}
                canSeeEstate={isSuper} companyId={companyId} />
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
  const [form, setForm] = useState({ url: '', platform: '', enabled: false, letter: '', interest: true, rental: false, maintenance: false });
  const [token, setToken] = useState('');
  const [systemKey, setSystemKey] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [check, setCheck] = useState(null);
  const [open, setOpen] = useState(false);

  // `resetForm` false keeps what is being typed (saving the key mid-edit).
  const load = (resetForm = true) => api.companyEstate(companyId).then((r) => {
    setS(r);
    if (resetForm) {
      setForm({
        url: r.url || '', platform: r.platform || '', enabled: !!r.enabled,
        letter: r.letter || '',
        interest: r.scopes?.interest !== false, rental: !!r.scopes?.rental, maintenance: !!r.scopes?.maintenance,
      });
      if (!r.enabled) setOpen(true);
    } else {
      if (!r.hasToken) setForm((f) => ({ ...f, enabled: false }));
      if (!r.hasSecret) setForm((f) => ({ ...f, rental: false, maintenance: false }));
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
  const saveSystemKey = (value) => run('systemKey', async () => {
    const r = await api.saveCompanyEstateSystemKey(companyId, value);
    setSystemKey('');
    push(r.hasSystemKey ? 'تم حفظ مفتاح النظام' : 'أُزيل مفتاح النظام، ويُستخدم مفتاح الاهتمام مكانه', 'success');
    await load(false); onChange?.();
  });
  const saveSecret = (value) => run('secret', async () => {
    const r = await api.saveCompanyEstateSecret(companyId, value);
    setSecret('');
    push(r.hasSecret ? 'تم حفظ المفتاح السري' : 'أُزيل المفتاح السري، وأُوقف إرسال التأجير والصيانة', 'success');
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
            {s.enabled
              ? `يعمل: ${[s.scopes?.interest !== false && 'الاهتمام', s.scopes?.rental && 'التأجير', s.scopes?.maintenance && 'الصيانة'].filter(Boolean).join('، ') || 'لا شيء مفعّل'}`
              : 'غير مفعّل'}
          </span>
          {open ? <ChevronUp className="w-4 h-4 text-ink-400" /> : <ChevronDown className="w-4 h-4 text-ink-400" />}
        </span>
      </button>

      {open && (
        <>
          <p className="text-[12px] text-ink-500 leading-relaxed">
            تُرسل الطلبات التي يسجّلها الوكيل إلى نظام Estate الخاص بالشركة: من المكالمة بعد انتهائها، ومن واتساب حين يؤكد العميل طلبه، كلٌّ إلى واجهته:
            الاهتمام بالشراء، والتأجير (سكني أو تجاري أو مكتبي)، والصيانة. وتُرسل اختيارات العميل في حقولها في Estate (نوع العقار، طريقة الدفع، كيف سمعت عنا…)،
            وما ليس له حقل في الملاحظة مع اسم المساعد والشركة. مهير ووكن على Estate واحد، ويُميَّز الطلب برمز المشروع واسم المساعد. ويظهر بجانب كل طلب ما جرى له.
          </p>

          <div>
            <label className="block text-[12px] font-medium text-ink-700 mb-1">عنوان Estate الخاص بالشركة</label>
            <input dir="ltr" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://maher.e-statee.com" className={cn(input, 'font-mono text-[12px]')} />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-1">
              <label className="block text-[12px] font-medium text-ink-700">مفتاح الاهتمام (api-key)</label>
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
            <p className="mt-1 text-[11.5px] text-ink-500">مفتاح واجهة طلبات الاهتمام بالشراء (Make). لا يُعرض بعد الحفظ، ولا يصل إلى المتصفح.</p>
            {s.keyHint && (
              <p className="mt-1 text-[11.5px] text-ink-600">
                المفتاح المحفوظ يبدأ بـ <span dir="ltr" className="font-mono">{s.keyHint.start || '—'}</span> وينتهي بـ <span dir="ltr" className="font-mono">{s.keyHint.end || '—'}</span>، وطوله {s.keyHint.length} حرفاً. قارنه بالمفتاح الذي أرسله Estate.
                {s.keyHint.cleaned && <span className="block text-amber-800">كان فيه رموز مخفية أو مسافات نُسخت معه، وتُحذف قبل الإرسال.</span>}
              </p>
            )}
            {s.hasToken && (
              <button type="button" className="mt-1 text-[11.5px] text-rose-700 underline disabled:opacity-50" disabled={!!busy}
                onClick={() => saveToken('')}>إزالة المفتاح</button>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-1">
              <label className="block text-[12px] font-medium text-ink-700">مفتاح النظام (x-api-key)</label>
              <span className={cn('text-[11.5px] font-semibold', s.hasSystemKey ? 'text-emerald-700' : 'text-ink-500')}>
                {s.hasSystemKey ? 'المفتاح محفوظ' : 'يُستخدم مفتاح الاهتمام'}
              </span>
            </div>
            <div className="flex gap-2">
              <input type="password" autoComplete="off" dir="ltr" value={systemKey} onChange={(e) => setSystemKey(e.target.value)}
                placeholder={s.hasSystemKey ? 'لاستبدال المفتاح، الصق مفتاحاً جديداً' : 'الصق x-api-key الذي أعطاك إياه Estate'}
                className={cn(input, 'flex-1 font-mono text-[12px]')} />
              <Button variant="secondary" disabled={!systemKey.trim()} loading={busy === 'systemKey'} onClick={() => saveSystemKey(systemKey.trim())}>حفظ المفتاح</Button>
            </div>
            <p className="mt-1 text-[11.5px] text-ink-500">لواجهتي التأجير والصيانة، مع المفتاح السري. إن تُرك فارغاً يُرسل مفتاح الاهتمام مكانه.</p>
            {s.systemKeyHint && (
              <p className="mt-1 text-[11.5px] text-ink-600">
                المحفوظ يبدأ بـ <span dir="ltr" className="font-mono">{s.systemKeyHint.start || '—'}</span> وينتهي بـ <span dir="ltr" className="font-mono">{s.systemKeyHint.end || '—'}</span>، وطوله {s.systemKeyHint.length} حرفاً.
              </p>
            )}
            {s.hasSystemKey && (
              <button type="button" className="mt-1 text-[11.5px] text-rose-700 underline disabled:opacity-50" disabled={!!busy}
                onClick={() => saveSystemKey('')}>إزالة مفتاح النظام</button>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-1">
              <label className="block text-[12px] font-medium text-ink-700">المفتاح السري (x-secret-key)</label>
              <span className={cn('text-[11.5px] font-semibold', s.hasSecret ? 'text-emerald-700' : 'text-ink-500')}>
                {s.hasSecret ? 'المفتاح محفوظ' : 'لا يوجد مفتاح'}
              </span>
            </div>
            <div className="flex gap-2">
              <input type="password" autoComplete="off" dir="ltr" value={secret} onChange={(e) => setSecret(e.target.value)}
                placeholder={s.hasSecret ? 'لاستبدال المفتاح، الصق مفتاحاً جديداً' : 'الصق المفتاح السري الذي أعطاك إياه Estate'}
                className={cn(input, 'flex-1 font-mono text-[12px]')} />
              <Button variant="secondary" disabled={!secret.trim()} loading={busy === 'secret'} onClick={() => saveSecret(secret.trim())}>حفظ المفتاح</Button>
            </div>
            <p className="mt-1 text-[11.5px] text-ink-500">لواجهتي التأجير والصيانة، مع مفتاح النظام. لا يُعرض بعد الحفظ، ولا يصل إلى المتصفح.</p>
            {s.secretHint && (
              <p className="mt-1 text-[11.5px] text-ink-600">
                المحفوظ يبدأ بـ <span dir="ltr" className="font-mono">{s.secretHint.start || '—'}</span> وينتهي بـ <span dir="ltr" className="font-mono">{s.secretHint.end || '—'}</span>، وطوله {s.secretHint.length} حرفاً.
              </p>
            )}
            {s.hasSecret && (
              <button type="button" className="mt-1 text-[11.5px] text-rose-700 underline disabled:opacity-50" disabled={!!busy}
                onClick={() => saveSecret('')}>إزالة المفتاح السري</button>
            )}
          </div>

          <div>
            <label className="block text-[12px] font-medium text-ink-700 mb-1">قيمة المصدر (platform)</label>
            <input dir="ltr" value={form.platform} maxLength={60} onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))}
              className={cn(input, 'font-mono text-[12px]')} />
            <p className="mt-1 text-[11.5px] text-ink-500">القيمة التي اعتمدها Estate لطلبات المساعد الذكي هي <span dir="ltr" className="font-mono">ai_chat</span>، وتُستخدم إن تُرك الحقل فارغاً.</p>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-ink-700 mb-1">حرف الشركة في رموز مشاريع Estate</label>
            <input dir="ltr" value={form.letter} maxLength={4}
              onChange={(e) => setForm((f) => ({ ...f, letter: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') }))}
              placeholder="W" className={cn(input, 'w-28 font-mono text-[13px]')} />
            <p className="mt-1 text-[11.5px] text-ink-500 leading-relaxed">
              W لوكن وM لمهير. يُبنى رمز المشروع منه ومن رقم المشروع الذي يذكره العميل: «وكن 38» يُرسل W-38، و«مهير 12» يُرسل M-12.
              وإن لم يذكر العميل رقم مشروع يُرسل الطلب بلا مشروع، وكل شركة تُرسل مشاريعها فقط.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-ink-100 px-4 py-3 cursor-pointer">
            <input type="checkbox" className="mt-1 w-4 h-4 accent-brand-600" checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
            <span>
              <span className="block text-[13px] font-medium text-ink-900">إرسال الطلبات إلى Estate من المكالمات وواتساب</span>
              <span className="block text-[12px] text-ink-500 mt-0.5">يحتاج العنوان والمفتاح. واختر ما يُرسل:</span>
            </span>
          </label>
          <div className="flex flex-wrap gap-x-6 gap-y-2 pr-11 -mt-2">
            {[
              ['interest', 'طلبات الاهتمام بالشراء', false],
              ['rental', 'طلبات التأجير', true],
              ['maintenance', 'طلبات الصيانة', true],
            ].map(([k, label, needsSecret]) => (
              <label key={k} className={cn('flex items-center gap-2 text-[12.5px] text-ink-800', needsSecret && !s.hasSecret ? 'opacity-50' : 'cursor-pointer')}>
                <input type="checkbox" className="w-4 h-4 accent-brand-600" checked={!!form[k]} disabled={needsSecret && !s.hasSecret}
                  onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} />
                {label}{needsSecret && !s.hasSecret ? ' (تحتاج المفتاح السري)' : ''}
              </label>
            ))}
          </div>

          {check && [check, ...(check.more || [])].map((c, i) => (
            <div key={i} className={cn('rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed',
              c.ok ? (c.warn ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-emerald-50 border-emerald-200 text-emerald-800')
                : c.warn ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-rose-50 border-rose-200 text-rose-800')}>
              {c.text}
            </div>
          ))}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={!s.hasToken || !form.url.trim()} loading={busy === 'check'} onClick={runCheck}>فحص الاتصال</Button>
            <Button variant="brand" loading={busy === 'save'} onClick={save}>حفظ</Button>
          </div>
          <p className="text-[11.5px] text-ink-500 leading-relaxed">
            «فحص الاتصال» يرسل إلى واجهتي الاهتمام والتأجير طلباً بلا بيانات، والمتوقع أن يرفضه Estate ويذكر الحقول التي يشترطها، وإن قبله فستظهر رسالة تطلب حذفه.
            ويقرأ بيانات الصيانة من Estate ويذكر عدد المشاريع والمباني والوحدات التي فيها، وبها يُعرف مشروع العميل ومبناه ووحدته عند إرسال طلب صيانة.
          </p>
        </>
      )}
    </Card>
  );
}
