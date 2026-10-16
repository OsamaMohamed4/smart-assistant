import { useEffect, useMemo, useState } from 'react';
import { Copy, CheckCircle2, AlertTriangle, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Label } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtDate } from '../lib/utils';

// WhatsApp per company, through the client's LoopChat account. Superadmin
// only: the channel is what ties incoming messages to a company, the same way
// a phone number ties calls to one.

const TRIGGERS = [
  { value: 'off',      label: 'لا ترسل' },
  { value: 'request',  label: 'عند تسجيل طلب في المكالمة' },
  { value: 'answered', label: 'بعد كل مكالمة تم الرد عليها' },
];
const SOURCES = [
  { value: 'customer_name', label: 'اسم العميل (من الطلب)' },
  { value: 'company_name',  label: 'اسم الشركة' },
  { value: 'agent_name',    label: 'اسم المساعد' },
  { value: 'request_type',  label: 'نوع الطلب' },
  { value: 'fixed',         label: 'نص ثابت' },
];
const STATUS = {
  received: { label: 'استُلمت', tone: 'bg-ink-100 text-ink-700' },
  sent    : { label: 'أُرسلت', tone: 'bg-emerald-50 text-emerald-700' },
  failed  : { label: 'لم تُرسل', tone: 'bg-rose-50 text-rose-700' },
  skipped : { label: 'لم تُرسل', tone: 'bg-amber-50 text-amber-800' },
  pending : { label: 'قيد الإرسال', tone: 'bg-sky-50 text-sky-700' },
};
const KIND = { text: 'نص', media: 'وسائط', template: 'قالب' };

const isApproved = (t) => String(t.status || '').toUpperCase() === 'APPROVED';

export function WhatsappPage() {
  const { push } = useToast();
  const [overview, setOverview]   = useState(null);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(null);
  const [form, setForm]           = useState(null);
  const [messages, setMessages]   = useState([]);
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    api.whatsappOverview().then(setOverview).catch((e) => push(e.message, 'error'));
    api.listCompanies().then((cs) => {
      setCompanies(cs || []);
      setCompanyId((cur) => cur || cs?.[0]?.id || null);
    }).catch((e) => push(e.message, 'error'));
  }, []);

  const loadCompany = (id) => api.companyWhatsapp(id).then((r) => {
    setForm({
      channelId: r.channelId || '',
      autoReply: !!r.autoReply,
      trigger  : r.followup?.trigger || 'off',
      templateId: r.followup?.templateId || '',
      variables: r.followup?.variables || [],
      headerUrl: r.followup?.headerUrl || '',
    });
    setMessages(r.messages || []);
  }).catch((e) => push(e.message, 'error'));

  useEffect(() => { if (companyId) loadCompany(companyId); }, [companyId]);

  const channels = overview?.channels || [];
  const templates = useMemo(
    () => (overview?.templates || []).filter((t) => isApproved(t) && String(t.channelId) === String(form?.channelId)),
    [overview, form?.channelId],
  );
  const template = templates.find((t) => String(t.id) === String(form?.templateId)) || null;

  // A template's {{1}}…{{n}} each need a value; keep one row per placeholder.
  useEffect(() => {
    if (!form || !template) return;
    if (form.variables.length === template.variables) return;
    setForm((f) => ({
      ...f,
      variables: Array.from({ length: template.variables }, (_, i) => f.variables[i] || { source: 'customer_name', text: '' }),
    }));
  }, [template?.id, template?.variables]);

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setVar = (i, k, v) => setForm((f) => ({ ...f, variables: f.variables.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));

  const save = async () => {
    setSaving(true);
    try {
      await api.saveCompanyWhatsapp(companyId, {
        channelId: form.channelId ? Number(form.channelId) : null,
        autoReply: form.autoReply,
        followup : form.trigger === 'off' ? { trigger: 'off' } : {
          trigger: form.trigger,
          templateId: form.templateId ? Number(form.templateId) : null,
          variables: form.variables,
          headerType: template?.headerFormat && template.headerFormat !== 'text' ? template.headerFormat : null,
          headerUrl: form.headerUrl,
        },
      });
      push('تم حفظ إعدادات واتساب', 'success');
      loadCompany(companyId);
    } catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const copy = (text) => navigator.clipboard.writeText(text).then(() => push('تم نسخ الرابط', 'success'), () => {});
  const company = companies.find((c) => c.id === companyId);
  const needsHeader = template && ['image', 'video', 'document'].includes(String(template.headerFormat || '').toLowerCase());

  return (
    <div>
      <TopBar
        title="واتساب"
        subtitle="ربط أرقام واتساب الشركات عبر LoopChat: رد المساعد على الرسائل، ورسالة بعد المكالمة."
        right={companies.length > 1 && (
          <select value={companyId || ''} onChange={(e) => setCompanyId(e.target.value)}
            className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      />

      <div className="px-8 py-7 space-y-6 max-w-4xl">
        {/* ─── Connection ─── */}
        <Card className="p-5 space-y-4">
          {!overview ? (
            <div className="text-[13px] text-ink-400">جارٍ التحقق من الربط…</div>
          ) : !overview.configured ? (
            <Notice tone="amber" icon={AlertTriangle}>
              مفتاح LoopChat غير مضبوط على الخادم. أضف <span dir="ltr" className="font-mono">LOOPCHAT_API_TOKEN</span> في متغيرات Railway ثم أعد النشر.
            </Notice>
          ) : overview.error ? (
            <Notice tone="rose" icon={AlertTriangle}>تعذّر الوصول إلى LoopChat: {overview.error}</Notice>
          ) : (
            <Notice tone="emerald" icon={CheckCircle2}>
              متصل بـ LoopChat · أرقام واتساب: {channels.length} · قوالب معتمدة: {(overview.templates || []).filter(isApproved).length}
            </Notice>
          )}

          {overview?.configured && (
            <div>
              <Label>رابط استقبال الرسائل (Webhook)</Label>
              {overview.webhookUrl ? (
                <>
                  <div className="flex gap-2">
                    <input readOnly value={overview.webhookUrl} dir="ltr"
                      className="flex-1 h-10 px-3 rounded-xl border border-ink-200 bg-ink-50 font-mono text-[12px] text-ink-700" />
                    <Button variant="secondary" onClick={() => copy(overview.webhookUrl)}><Copy className="w-3.5 h-3.5" /></Button>
                  </div>
                  <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
                    في LoopChat: الإعدادات ← Integrations ← أضف Webhook بهذا الرابط، واختر حدث «Incoming Message» وقناة واتساب.
                    إيقاف التكامل واستئنافه يُرسَلان تلقائياً: إذا استلم موظف محادثة من LoopChat يتوقف المساعد فيها حتى يعيدها.
                  </p>
                </>
              ) : (
                <p className="text-[12px] text-rose-700">رابط الخادم العام غير مضبوط (PUBLIC_BASE_URL)، فلا يمكن تكوين الرابط.</p>
              )}
            </div>
          )}
        </Card>

        {/* ─── This company ─── */}
        {company && form && (
          <Card className="p-5 space-y-5">
            <div className="text-[14px] font-semibold text-ink-900">{company.name}</div>

            <div>
              <Label>رقم واتساب الشركة</Label>
              <select value={form.channelId} onChange={(e) => set('channelId')(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-ink-200 bg-white text-[13px] focus-ring">
                <option value="">— غير مربوطة —</option>
                {/* The number is isolated left-to-right (LRI…PDI), or the + lands
                    at the wrong end inside a right-to-left option. */}
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.phoneNumber ? ` — ⁦${c.phoneNumber}⁩` : ''}</option>
                ))}
                {form.channelId && !channels.some((c) => String(c.id) === String(form.channelId)) && (
                  <option value={form.channelId}>قناة #{form.channelId}</option>
                )}
              </select>
              {channels.find((c) => String(c.id) === String(form.channelId))?.hasActiveBot && (
                <p className="mt-1.5 text-[11.5px] text-amber-700">في LoopChat بوت مفعّل على هذا الرقم. أوقفه هناك قبل تشغيل رد المساعد، حتى لا يرد الاثنان على العميل.</p>
              )}
            </div>

            <label className={cn('flex items-start gap-3 rounded-xl border px-4 py-3', form.channelId ? 'border-ink-100 cursor-pointer' : 'border-ink-100 opacity-60')}>
              <input type="checkbox" className="mt-1 w-4 h-4 accent-brand-600" disabled={!form.channelId}
                checked={form.autoReply && !!form.channelId} onChange={(e) => set('autoReply')(e.target.checked)} />
              <span>
                <span className="block text-[13px] font-medium text-ink-900">المساعد يرد على رسائل العملاء</span>
                <span className="block text-[12px] text-ink-500 mt-0.5 leading-relaxed">
                  بنفس سيناريو الشركة (تعليمات المكالمات الواردة) وقاعدة معرفتها. يرد على الرسائل النصية فقط، ويتوقف في أي محادثة يستلمها موظف من LoopChat.
                </span>
              </span>
            </label>

            <div className="space-y-3">
              <div>
                <Label>رسالة واتساب بعد المكالمة</Label>
                <select value={form.trigger} onChange={(e) => set('trigger')(e.target.value)} disabled={!form.channelId}
                  className="w-full h-10 px-3 rounded-xl border border-ink-200 bg-white text-[13px] focus-ring disabled:opacity-60">
                  {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <p className="mt-1.5 text-[11.5px] text-ink-500">تُرسل مرة واحدة لكل مكالمة، إلى رقم العميل إذا كان رقم جوال، بقالب معتمد من LoopChat.</p>
              </div>

              {form.trigger !== 'off' && form.channelId && (
                <>
                  <div>
                    <Label>القالب</Label>
                    <select value={form.templateId} onChange={(e) => set('templateId')(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border border-ink-200 bg-white text-[13px] focus-ring">
                      <option value="">— اختر قالباً —</option>
                      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.language ? ` (${t.language})` : ''}</option>)}
                    </select>
                    {!templates.length && (
                      <p className="mt-1.5 text-[11.5px] text-amber-700">لا توجد قوالب معتمدة على هذا الرقم في LoopChat بعد.</p>
                    )}
                  </div>

                  {template && (
                    <div className="rounded-xl bg-ink-50/70 border border-ink-100 px-4 py-3">
                      <div className="text-[11px] text-ink-500 mb-1">نص القالب</div>
                      <div className="text-[13px] text-ink-800 whitespace-pre-wrap leading-relaxed">{template.body}</div>
                    </div>
                  )}

                  {template && form.variables.map((v, i) => (
                    <div key={i} className="grid grid-cols-1 sm:grid-cols-[110px_1fr_1fr] gap-2 items-center">
                      <div className="text-[12.5px] font-mono text-ink-600" dir="ltr">{`{{${i + 1}}}`}</div>
                      <select value={v.source} onChange={(e) => setVar(i, 'source', e.target.value)}
                        className="h-9 px-3 rounded-xl border border-ink-200 bg-white text-[12.5px] focus-ring">
                        {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                      <input value={v.text} onChange={(e) => setVar(i, 'text', e.target.value)}
                        placeholder={v.source === 'fixed' ? 'النص' : 'نص بديل إذا لم تتوفر القيمة'}
                        className="h-9 px-3 rounded-xl border border-ink-200 bg-white text-[12.5px] focus-ring" />
                    </div>
                  ))}

                  {needsHeader && (
                    <div>
                      <Label>رابط {template.headerFormat === 'image' ? 'صورة' : 'ملف'} رأس القالب</Label>
                      <input value={form.headerUrl} onChange={(e) => set('headerUrl')(e.target.value)} dir="ltr"
                        placeholder="https://…" className="w-full h-10 px-3 rounded-xl border border-ink-200 bg-white text-[12.5px] focus-ring" />
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex justify-end">
              <Button variant="brand" onClick={save} loading={saving}>حفظ</Button>
            </div>
          </Card>
        )}

        {/* ─── Recent messages ─── */}
        {company && (
          <Card className="overflow-x-auto">
            <div className="px-5 pt-4 pb-2 text-[13px] font-semibold text-ink-900">آخر الرسائل</div>
            {!messages.length ? (
              <div className="px-5 pb-5 text-[12.5px] text-ink-500">لا توجد رسائل بعد.</div>
            ) : (
              <table className="w-full text-[12.5px]">
                <tbody>
                  {messages.map((m) => {
                    const st = STATUS[m.status] || STATUS.failed;
                    return (
                      <tr key={m.id} className="border-t border-ink-100 align-top">
                        <td className="px-5 py-2.5 whitespace-nowrap text-ink-500 tabular-nums">{fmtDate(m.created_at)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {m.direction === 'in'
                            ? <span className="inline-flex items-center gap-1 text-emerald-700"><ArrowDownLeft className="w-3 h-3" />واردة</span>
                            : <span className="inline-flex items-center gap-1 text-amber-700"><ArrowUpRight className="w-3 h-3" />صادرة</span>}
                          <div className="text-[11px] text-ink-400">{KIND[m.kind] || m.kind}</div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-mono text-ink-600" dir="ltr">{m.contact_phone || '—'}</td>
                        <td className="px-3 py-2.5 text-ink-800 max-w-[340px]"><div className="line-clamp-2">{m.body || '—'}</div></td>
                        <td className="px-5 py-2.5">
                          <span className={cn('inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold', st.tone)}>{st.label}</span>
                          {m.detail && <div className="mt-1 text-[11px] text-ink-500 max-w-[220px]">{m.detail}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function Notice({ tone, icon: Icon, children }) {
  const cls = {
    amber  : 'bg-amber-50 border-amber-200 text-amber-900',
    rose   : 'bg-rose-50 border-rose-200 text-rose-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  }[tone];
  return (
    <div className={cn('flex items-start gap-2.5 rounded-xl border px-4 py-3 text-[13px] leading-relaxed', cls)}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

