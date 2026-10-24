import { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Label } from '../ui/Input';
import { useToast } from '../ui/Toast';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

// What the company controls about its WhatsApp assistant: the instructions it
// follows there, extra knowledge for that channel, and the weekly hours it
// answers in. Outside those hours the assistant stays silent and the
// company's own staff reply in LoopChat. None of this touches the connection
// (number, key, follow-up template) and none of it reaches the voice agents.

// Index 0 = Sunday, as the server counts.
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function WhatsappBehavior({ companyId }) {
  const { push } = useToast();
  const [data, setData]   = useState(null);
  const [form, setForm]   = useState(null);
  const [saving, setSaving] = useState(false);

  const apply = (r) => {
    setData(r);
    setForm({
      autoReply: !!r.autoReply,
      prompt: r.prompt || '',
      knowledge: r.knowledge || '',
      scheduleOn: !!r.schedule?.enabled,
      days: (r.schedule?.days || []).map((d) => ({ ...d })),
    });
  };

  useEffect(() => {
    if (!companyId) return;
    setData(null); setForm(null);
    api.whatsappControls(companyId).then(apply).catch((e) => push(e.message, 'error'));
  }, [companyId]);

  if (!data || !form) return <Card className="p-5 text-[13px] text-ink-400">جارٍ التحميل…</Card>;

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setDay = (i, k, v) => setForm((f) => ({ ...f, days: f.days.map((d, j) => (j === i ? { ...d, [k]: v } : d)) }));

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveWhatsappControls(companyId, {
        autoReply: form.autoReply,
        prompt: form.prompt,
        knowledge: form.knowledge,
        schedule: { enabled: form.scheduleOn, days: form.days },
      });
      apply(r);
      push('تم حفظ إعدادات رد واتساب', 'success');
    } catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const status = !data.connected
    ? { tone: 'bg-ink-100 text-ink-600', text: 'لا يوجد رقم واتساب مربوط بعد. يربطه مدير النظام.' }
    : !form.autoReply
      ? { tone: 'bg-amber-50 text-amber-800', text: 'الرد التلقائي متوقف' }
      : form.scheduleOn && !data.openNow
        ? { tone: 'bg-sky-50 text-sky-800', text: 'الآن خارج ساعات الرد: يرد الموظفون' }
        : { tone: 'bg-emerald-50 text-emerald-700', text: 'المساعد يرد الآن' };

  return (
    <Card className="p-5 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[14px] font-semibold text-ink-900">سلوك المساعد على واتساب</div>
        <span className={cn('px-2.5 py-1 rounded-lg text-[12px] font-semibold', status.tone)}>{status.text}</span>
      </div>

      {/* ─── on / off ─── */}
      <label className={cn('flex items-start gap-3 rounded-xl border px-4 py-3', data.connected ? 'border-ink-100 cursor-pointer' : 'border-ink-100 opacity-60')}>
        <input type="checkbox" className="mt-1 w-4 h-4 accent-brand-600" disabled={!data.connected}
          checked={form.autoReply && data.connected} onChange={(e) => set('autoReply')(e.target.checked)} />
        <span>
          <span className="block text-[13px] font-medium text-ink-900">المساعد يرد على رسائل العملاء</span>
          <span className="block text-[12px] text-ink-500 mt-0.5 leading-relaxed">
            إيقافه يوقف الرد التلقائي فوراً ويبقى الموظفون يردون من LoopChat.
          </span>
        </span>
      </label>

      {/* ─── weekly hours ─── */}
      <div className="space-y-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-1 w-4 h-4 accent-brand-600" checked={form.scheduleOn}
            onChange={(e) => set('scheduleOn')(e.target.checked)} />
          <span>
            <span className="block text-[13px] font-medium text-ink-900">تحديد ساعات رد المساعد</span>
            <span className="block text-[12px] text-ink-500 mt-0.5 leading-relaxed">
              المساعد يرد داخل الأوقات أدناه فقط، وخارجها يرد الموظفون. التوقيت بتوقيت الرياض. وإن أوقفت هذا الخيار يرد المساعد على مدار الساعة.
            </span>
          </span>
        </label>

        {form.scheduleOn && (
          <div className="rounded-xl border border-ink-100 divide-y divide-ink-100">
            {form.days.map((d, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                <label className="flex items-center gap-2 w-28 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 accent-brand-600" checked={d.on} onChange={(e) => setDay(i, 'on', e.target.checked)} />
                  <span className="text-[13px] text-ink-800">{DAYS[i]}</span>
                </label>
                {d.on ? (
                  <div className="flex items-center gap-2 text-[12.5px] text-ink-600">
                    من
                    <input type="time" value={d.from} onChange={(e) => setDay(i, 'from', e.target.value)} dir="ltr"
                      className="h-9 px-2 rounded-lg border border-ink-200 bg-white focus-ring" />
                    إلى
                    <input type="time" value={d.to} onChange={(e) => setDay(i, 'to', e.target.value)} dir="ltr"
                      className="h-9 px-2 rounded-lg border border-ink-200 bg-white focus-ring" />
                    {d.to < d.from && <span className="text-[11.5px] text-ink-500">(حتى اليوم التالي)</span>}
                  </div>
                ) : (
                  <span className="text-[12px] text-ink-400">لا يرد المساعد — الموظفون فقط</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── instructions ─── */}
      <div>
        <Label>تعليمات المساعد على واتساب</Label>
        <textarea value={form.prompt} onChange={(e) => set('prompt')(e.target.value)} rows={8} maxLength={data.limits.prompt}
          placeholder="اتركه فارغاً لاستخدام تعليمات المكالمات الواردة من السيناريو المفعّل."
          className="w-full px-3 py-2.5 rounded-xl border border-ink-200 bg-white text-[13px] leading-relaxed focus-ring" />
        <p className="mt-1.5 text-[11.5px] text-ink-500 leading-relaxed">
          هذه التعليمات لواتساب فقط، ولا تغيّر المكالمات الصوتية. إن تُركت فارغة يرد المساعد بتعليمات المكالمات الواردة كما كان.
          يمكنك استخدام <span dir="ltr" className="font-mono">{'{{agent_name}}'}</span> و<span dir="ltr" className="font-mono">{'{{company_name}}'}</span>.
        </p>
      </div>

      {/* ─── knowledge ─── */}
      <div>
        <Label>معرفة خاصة بواتساب</Label>
        <textarea value={form.knowledge} onChange={(e) => set('knowledge')(e.target.value)} rows={8} maxLength={data.limits.knowledge}
          placeholder="الصق هنا معلومات يحتاجها المساعد في واتساب: أسعار، عروض، أسئلة متكررة…"
          className="w-full px-3 py-2.5 rounded-xl border border-ink-200 bg-white text-[13px] leading-relaxed focus-ring" />
        <p className="mt-1.5 text-[11.5px] text-ink-500 leading-relaxed">
          نص يُضاف إلى معرفة المساعد في واتساب فقط. قاعدة المعرفة العامة للشركة (الملفات) تبقى تعمل كما هي في كل القنوات.
          {' '}{form.knowledge.length.toLocaleString('en-US')} / {data.limits.knowledge.toLocaleString('en-US')} حرف.
        </p>
      </div>

      <div className="flex justify-end">
        <Button variant="brand" onClick={save} loading={saving}>حفظ</Button>
      </div>
    </Card>
  );
}
