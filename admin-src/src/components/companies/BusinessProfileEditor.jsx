import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Info, AlertTriangle } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input, Textarea, Label } from '../ui/Input';
import { useToast } from '../ui/Toast';
import { api } from '../../lib/api';

// Editor for the company's FACTS — the data a caller might ask for. These end
// up in the published agent's prompt as a delimited block.
//
// The rule the whole feature rests on: these fields hold DATA, never behaviour.
// How the agent should speak, what tone to use, what to do when it does not
// know something — all of that is the operator's scenario text and is edited on
// the Scenarios page. The hints below say so at each field, because the natural
// instinct when given a "rules" box is to start writing instructions into it.
//
// Nothing here is pre-filled. A company that has entered nothing produces NO
// facts block at all, and its prompt is byte-identical to one built before this
// feature existed — so an empty form must stay genuinely empty.

// Calendar scaffolding, not business data: a day only reaches the payload once
// the operator gives it a state. Saudi week order, starting Sunday.
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const DAY_STATE = { UNSET: 'unset', OPEN: 'open', CLOSED: 'closed' };

/** Stored workingHours[] -> per-day UI rows. Unknown days are preserved. */
function hoursToRows(workingHours) {
  const byDay = new Map();
  for (const e of Array.isArray(workingHours) ? workingHours : []) {
    const day = String(e?.days || '').trim();
    if (!day) continue;
    byDay.set(day, e.closed
      ? { state: DAY_STATE.CLOSED, from: '', to: '' }
      : { state: DAY_STATE.OPEN, from: e.from || '', to: e.to || '' });
  }
  const rows = WEEKDAYS.map((day) => ({
    day,
    ...(byDay.get(day) || { state: DAY_STATE.UNSET, from: '', to: '' }),
  }));
  // A profile saved with a custom range label ("الأحد إلى الخميس") is not one
  // of the seven rows. Keep it rather than silently deleting the operator's
  // data the moment they open this screen.
  for (const [day, v] of byDay) {
    if (!WEEKDAYS.includes(day)) rows.push({ day, custom: true, ...v });
  }
  return rows;
}

/** UI rows -> the stored shape. Rows with no state contribute nothing. */
function rowsToHours(rows) {
  const out = [];
  for (const r of rows) {
    if (r.state === DAY_STATE.CLOSED) out.push({ days: r.day, closed: true });
    else if (r.state === DAY_STATE.OPEN && (r.from || r.to)) {
      out.push({ days: r.day, ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) });
    }
  }
  return out;
}

const blankList = (arr) => (Array.isArray(arr) && arr.length ? [...arr] : ['']);

function ListField({ label, hint, placeholder, values, onChange, addLabel }) {
  const set = (i, v) => onChange(values.map((x, n) => (n === i ? v : x)));
  const add = () => onChange([...values, '']);
  const remove = (i) => {
    const next = values.filter((_, n) => n !== i);
    onChange(next.length ? next : ['']);
  };
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="space-y-2">
        {values.map((v, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={v}
              placeholder={placeholder}
              onChange={(e) => set(i, e.target.value)}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label="حذف"
              onClick={() => remove(i)}
              disabled={values.length === 1 && !v}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="ghost" size="sm" type="button" className="mt-2" onClick={add}>
        <Plus className="w-3.5 h-3.5" /> {addLabel}
      </Button>
    </div>
  );
}

export function BusinessProfileEditor({ companyId, companyName }) {
  const { push } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [dirty, setDirty]     = useState(false);

  const [description, setDescription] = useState('');
  const [rows, setRows]               = useState(hoursToRows([]));
  const [services, setServices]       = useState(['']);
  const [rules, setRules]             = useState(['']);
  const [extras, setExtras]           = useState([{ label: '', value: '' }]);

  const [preview, setPreview] = useState({ factsBlock: '', hasFacts: false, valid: true, issues: [] });

  // Assemble the exact payload the API expects. Empty strings are dropped here
  // rather than sent and filtered server-side, so what the preview renders is
  // what gets stored.
  const buildProfile = useCallback(() => {
    const clean = (arr) => arr.map((s) => String(s || '').trim()).filter(Boolean);
    const profile = {};
    const d = description.trim();
    if (d) profile.description = d;
    const hours = rowsToHours(rows);
    if (hours.length) profile.workingHours = hours;
    const s = clean(services);
    if (s.length) profile.services = s;
    const r = clean(rules);
    if (r.length) profile.rules = r;
    const e = extras
      .map((x) => ({ label: String(x.label || '').trim(), value: String(x.value || '').trim() }))
      .filter((x) => x.label && x.value);
    if (e.length) profile.extraFacts = e;
    return profile;
  }, [description, rows, services, rules, extras]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.getBusinessProfile(companyId)
      .then((r) => {
        if (!alive) return;
        const p = r.businessProfile || {};
        setDescription(p.description || '');
        setRows(hoursToRows(p.workingHours));
        setServices(blankList(p.services));
        setRules(blankList(p.rules));
        setExtras(p.extraFacts?.length ? [...p.extraFacts] : [{ label: '', value: '' }]);
        setDirty(false);
      })
      .catch((e) => push(e.message, 'error'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [companyId]);

  // Live preview, rendered by the SERVER from the current draft. Debounced so
  // typing does not produce a request per keystroke.
  const timer = useRef(null);
  useEffect(() => {
    if (loading) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.previewBusinessProfile(companyId, buildProfile())
        .then(setPreview)
        .catch(() => { /* preview is advisory; never block editing on it */ });
    }, 400);
    return () => clearTimeout(timer.current);
  }, [companyId, loading, buildProfile]);

  const touch = (fn) => (...args) => { setDirty(true); fn(...args); };

  const onSave = async () => {
    setSaving(true);
    try {
      const r = await api.saveBusinessProfile(companyId, buildProfile());
      setPreview({ factsBlock: r.factsBlock || '', hasFacts: !!r.factsBlock, valid: true, issues: [] });
      setDirty(false);
      push('تم حفظ بيانات الشركة', 'success');
    } catch (e) {
      push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-[13px] text-ink-500">جارِ التحميل…</div>;

  return (
    <div className="space-y-5">
      {/* The one thing that must be understood before typing anything here. */}
      <div className="flex gap-2.5 rounded-xl border border-ink-200 bg-ink-50/60 px-4 py-3">
        <Info className="w-4 h-4 text-ink-500 shrink-0 mt-0.5" strokeWidth={2} />
        <p className="text-[12.5px] text-ink-600 leading-relaxed">
          هذه <strong className="text-ink-800">حقائق</strong> عن الشركة فقط — لا تعليمات للوكيل.
          أسلوب الحديث والتعليمات تُكتب في <strong className="text-ink-800">السيناريو</strong>.
          الحقول الفارغة لا تظهر للوكيل إطلاقاً.
        </p>
      </div>

      <Card>
        <CardHeader><h3 className="text-[15px] font-semibold text-ink-900">نبذة عن الشركة</h3></CardHeader>
        <CardBody>
          <Textarea
            rows={4}
            value={description}
            placeholder="نشاط الشركة ومجال عملها — جملة أو جملتان."
            onChange={touch((e) => setDescription(e.target.value))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-[15px] font-semibold text-ink-900">ساعات العمل</h3>
          <p className="text-[12px] text-ink-500 mt-0.5">اليوم الذي تتركه «غير محدد» لا يُذكر للعميل.</p>
        </CardHeader>
        <CardBody className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.day} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[13px] text-ink-700">{r.day}</span>
              <select
                value={r.state}
                onChange={touch((e) => setRows(rows.map((x, n) => (n === i ? { ...x, state: e.target.value } : x))))}
                className="h-10 px-3 pr-8 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring focus:border-ink-300"
              >
                <option value={DAY_STATE.UNSET}>غير محدد</option>
                <option value={DAY_STATE.OPEN}>مفتوح</option>
                <option value={DAY_STATE.CLOSED}>مغلق</option>
              </select>
              {r.state === DAY_STATE.OPEN && (
                <>
                  <Input
                    type="time" className="w-32" value={r.from}
                    onChange={touch((e) => setRows(rows.map((x, n) => (n === i ? { ...x, from: e.target.value } : x))))}
                  />
                  <span className="text-ink-400 text-[13px]">إلى</span>
                  <Input
                    type="time" className="w-32" value={r.to}
                    onChange={touch((e) => setRows(rows.map((x, n) => (n === i ? { ...x, to: e.target.value } : x))))}
                  />
                </>
              )}
              {r.custom && (
                <span className="text-[11px] text-ink-400">نطاق مخصص</span>
              )}
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-6">
          <ListField
            label="الخدمات"
            hint="ما تقدّمه الشركة"
            placeholder="مثال: بيع وشراء العقارات"
            values={services}
            onChange={touch(setServices)}
            addLabel="إضافة خدمة"
          />
          <ListField
            label="قواعد العمل"
            hint="حقائق تشغيلية — لا تعليمات للوكيل"
            placeholder="مثال: جميع الأسعار بالريال السعودي"
            values={rules}
            onChange={touch(setRules)}
            addLabel="إضافة قاعدة"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-[15px] font-semibold text-ink-900">معلومات إضافية</h3>
          <p className="text-[12px] text-ink-500 mt-0.5">أي حقيقة أخرى — رقم ترخيص، مقر، نطاق خدمة.</p>
        </CardHeader>
        <CardBody>
          <div className="space-y-2">
            {extras.map((x, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  className="w-1/3" value={x.label} placeholder="العنوان"
                  onChange={touch((e) => setExtras(extras.map((y, n) => (n === i ? { ...y, label: e.target.value } : y))))}
                />
                <Input
                  value={x.value} placeholder="القيمة"
                  onChange={touch((e) => setExtras(extras.map((y, n) => (n === i ? { ...y, value: e.target.value } : y))))}
                />
                <Button
                  variant="ghost" size="icon" type="button" aria-label="حذف"
                  onClick={touch(() => {
                    const next = extras.filter((_, n) => n !== i);
                    setExtras(next.length ? next : [{ label: '', value: '' }]);
                  })}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <Button variant="ghost" size="sm" type="button" className="mt-2"
            onClick={touch(() => setExtras([...extras, { label: '', value: '' }]))}>
            <Plus className="w-3.5 h-3.5" /> إضافة معلومة
          </Button>
        </CardBody>
      </Card>

      {/* Rendered by the server from the current draft — byte-identical to what
          publishing sends, because it is the same function. */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold text-ink-900">معاينة ما سيصل للوكيل</h3>
            <p className="text-[12px] text-ink-500 mt-0.5">
              النص الحرفي الذي يُضاف إلى تعليمات السيناريو عند النشر.
            </p>
          </div>
          {preview.hasFacts && (
            <span className="text-[11px] text-ink-500 shrink-0">{preview.factsBlock.length} حرف</span>
          )}
        </CardHeader>
        <CardBody>
          {!preview.valid && preview.issues?.length > 0 && (
            <div className="mb-3 flex gap-2.5 rounded-xl border border-accent-rose/30 bg-accent-rose/5 px-4 py-3">
              <AlertTriangle className="w-4 h-4 text-accent-rose shrink-0 mt-0.5" strokeWidth={2} />
              <div className="text-[12.5px] text-ink-700">
                <p className="font-medium mb-1">بيانات غير صالحة:</p>
                <ul className="space-y-0.5">
                  {preview.issues.map((i, n) => (
                    <li key={n} className="text-ink-600">{i.path}: {i.message}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {preview.hasFacts ? (
            <pre
              dir="rtl"
              className="whitespace-pre-wrap break-words font-arabic text-[12.5px] leading-relaxed
                         text-ink-700 bg-ink-50/60 border border-ink-100 rounded-xl p-4 max-h-80 overflow-auto"
            >{preview.factsBlock.trim()}</pre>
          ) : (
            <p className="text-[12.5px] text-ink-500">
              لا توجد بيانات بعد — لن يُضاف أي شيء إلى تعليمات الوكيل.
            </p>
          )}
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={onSave} loading={saving} disabled={!dirty && !saving}>
          حفظ
        </Button>
        {dirty && <span className="text-[12.5px] text-ink-500">تغييرات غير محفوظة</span>}
        {!dirty && preview.hasFacts && (
          <span className="text-[12.5px] text-ink-500">
            محفوظ — انشر الشركة لتصل هذه البيانات للوكيل.
          </span>
        )}
      </div>
    </div>
  );
}
