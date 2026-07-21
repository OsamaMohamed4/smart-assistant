import { useEffect, useState, useCallback } from 'react';
import { PhoneOutgoing, Plus, Play, Pause, XCircle, RefreshCw, Users, ChevronLeft, BarChart3, Clock, FileUp, Zap, AlertTriangle } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { Input, Label } from '../components/ui/Input';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { relTime } from '../lib/utils';
import { CampaignReportPage } from './CampaignReportPage';

const STATUS_META = {
  draft    : { label: 'مسودة',    tone: 'neutral' },
  running  : { label: 'تعمل',     tone: 'success' },
  paused   : { label: 'متوقفة',   tone: 'warning' },
  completed: { label: 'اكتملت',   tone: 'info' },
  cancelled: { label: 'ملغاة',    tone: 'neutral' },
};
const CONTACT_META = {
  pending  : { label: 'بالانتظار', tone: 'neutral' },
  calling  : { label: 'جارٍ الاتصال', tone: 'warning' },
  completed: { label: 'تمت', tone: 'success' },
  no_answer: { label: 'لم يرد', tone: 'info' },
  failed   : { label: 'فشلت', tone: 'danger' },
  cancelled: { label: 'ملغاة', tone: 'neutral' },
};

// Human Arabic explanation for a tick/diagnose reason — turns the engine's
// machine reason into something the operator can act on.
const REASON_AR = {
  dialed        : (r) => `تم بدء ${r.placed} مكالمة الآن`,
  no_pending    : () => 'لا توجد أرقام بانتظار الاتصال',
  completed     : () => 'اكتملت الحملة — كل الأرقام تمت',
  outside_window: (r) => `خارج نافذة الاتصال — تستأنف ${r.detail?.window?.split('-')[0] || ''}`,
  no_slots      : (r) => `بلغت الحد الأقصى للمكالمات المتزامنة (${r.detail?.calling || ''})`,
  not_published : () => 'الشركة غير منشورة على Vapi — انشرها أولاً',
  no_number     : () => 'لا يوجد رقم صادر مضبوط لهذه الشركة',
  daily_cap     : () => 'بلغت الحد اليومي للمكالمات الصادرة',
  error         : (r) => `خطأ: ${r.error || 'غير معروف'}`,
};
const reasonText = (r) => (REASON_AR[r.reason] || (() => `الحالة: ${r.reason}`))(r);

// HH:MM from separate hour/minute columns (fallback when the server didn't
// send a window object, e.g. an older cached response).
const hhmm = (h, m) => `${String(Number(h) || 0).padStart(2, '0')}:${String(Number(m) || 0).padStart(2, '0')}`;
// "بعد ٢ ساعة و١٥ دقيقة" style wait label from a minutes count.
const fmtWait = (mins) => {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h} ساعة و${m} دقيقة`;
  if (h) return `${h} ساعة`;
  return `${m} دقيقة`;
};

export function CampaignsPage({ pinnedCompanyId }) {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(pinnedCompanyId || null);
  const [campaigns, setCampaigns] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOf, setDetailOf] = useState(null);
  const [reportOf, setReportOf] = useState(null);
  const [cancelOf, setCancelOf] = useState(null);

  useEffect(() => {
    if (pinnedCompanyId) { setCompanyId(pinnedCompanyId); return; }
    api.listCompanies().then((cs) => {
      setCompanies(cs || []);
      setCompanyId((curr) => curr || cs?.[0]?.id || null);
    }).catch((e) => push(e.message, 'error'));
  }, [pinnedCompanyId]);

  const load = useCallback(() => {
    if (!companyId) return;
    api.listCampaigns(companyId).then(setCampaigns).catch((e) => push(e.message, 'error'));
  }, [companyId, push]);

  useEffect(() => { setCampaigns(null); load(); }, [load]);

  // Live refresh while anything is running.
  useEffect(() => {
    if (!campaigns?.some((c) => c.status === 'running')) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [campaigns, load]);

  const act = async (fn, okMsg) => {
    try { await fn(); push(okMsg, 'success'); load(); }
    catch (e) { push(e.message, 'error'); }
  };

  // Force one tick now and tell the operator EXACTLY what happened / why not.
  const runNow = async (c) => {
    try {
      const r = await api.campaignRunNow(companyId, c.id);
      const tone = r.reason === 'dialed' ? 'success'
        : ['not_published', 'no_number', 'error'].includes(r.reason) ? 'error' : 'warning';
      push(reasonText(r), tone);
      load();
    } catch (e) { push(e.message, 'error'); }
  };

  // Is the outbound worker actually executing? Surfaced so a stuck WORKER is
  // never mistaken for a stuck campaign.
  const worker = campaigns?.[0]?.worker || null;

  const total = (c) => Object.values(c.stats || {}).reduce((s, n) => s + n, 0);
  const done  = (c) => (c.stats?.completed || 0) + (c.stats?.no_answer || 0) + (c.stats?.failed || 0) + (c.stats?.cancelled || 0);

  // The report is a full page rather than a modal — cards, filters and a wide
  // table don't fit a dialog on a phone. Placed AFTER every hook above so the
  // hook order stays identical on each render.
  if (reportOf) {
    return (
      <CampaignReportPage
        companyId={companyId}
        campaign={reportOf}
        onBack={() => { setReportOf(null); load(); }}
      />
    );
  }

  return (
    <div>
      <TopBar
        title="الحملات الصادرة"
        subtitle="قوائم اتصال يتصل بها الوكيل تلقائياً داخل نافذة زمنية يومية."
        right={<>
          {!pinnedCompanyId && companies.length > 1 && (
            <select value={companyId || ''} onChange={(e) => setCompanyId(e.target.value)}
              className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring">
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <Button variant="secondary" size="md" onClick={load} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> تحديث
          </Button>
          <Button variant="brand" size="md" onClick={() => setCreateOpen(true)} className="gap-1.5" disabled={!companyId}>
            <Plus className="w-3.5 h-3.5" strokeWidth={2.5} /> حملة جديدة
          </Button>
        </>}
      />

      <div className="px-8 py-7 max-w-4xl">
        {/* Worker down = EVERY campaign is stuck. Say so loudly, once. */}
        {worker && worker.healthy === false && (
          <div className="mb-4 flex items-center gap-2 text-[12.5px] text-rose-700 bg-rose-50 ring-1 ring-rose-200/70 rounded-xl px-4 py-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>مشغّل الحملات لا يعمل حالياً — لن تُجرى مكالمات حتى يعود. آخر تنفيذ: {worker.lastTickAt ? relTime(worker.lastTickAt) : 'لم يبدأ بعد'}.</span>
          </div>
        )}
        {campaigns && campaigns.length === 0 && (
          <EmptyState icon={PhoneOutgoing} title="لا توجد حملات بعد"
            description="أنشئ حملة، الصق الأرقام، ثم اضغط تشغيل — الوكيل يتصل بها تلقائياً داخل النافذة الزمنية."
            action={<Button variant="brand" onClick={() => setCreateOpen(true)} className="gap-1.5"><Plus className="w-3.5 h-3.5" /> حملة جديدة</Button>}
          />
        )}
        <div className="space-y-3">
          {(campaigns || []).map((c) => {
            const meta = STATUS_META[c.status] || STATUS_META.draft;
            const t = total(c); const d = done(c);
            const pct = t ? Math.round((d / t) * 100) : 0;
            return (
              <div key={c.id} className="bg-white border border-ink-100 rounded-2xl shadow-card p-5">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-[15px] text-ink-900 truncate">{c.name}</h3>
                      <Badge tone={meta.tone} dot>{meta.label}</Badge>
                    </div>
                    <div className="mt-1 text-[11.5px] text-ink-500">
                      {t} رقم · نافذة {c.window?.startLabel || hhmm(c.start_hour, c.start_minute)}–{c.window?.endLabel || hhmm(c.end_hour, c.end_minute)} · تزامن {c.max_concurrent} · محاولات {c.max_attempts} · {relTime(c.created_at)}
                    </div>
                    {/* Explain a running-but-idle campaign so "pending" is never a mystery. */}
                    {c.status === 'running' && c.window && !c.window.open && (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 ring-1 ring-amber-200/60 rounded-md px-2 py-0.5">
                        <Clock className="w-3 h-3" />
                        خارج نافذة الاتصال الآن — يستأنف الساعة {c.window.startLabel} {c.window.opensInMin != null ? `(بعد ${fmtWait(c.window.opensInMin)})` : ''}
                      </div>
                    )}
                    {c.status === 'running' && c.window?.open && done(c) === 0 && t > 0 && (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200/60 rounded-md px-2 py-0.5">
                        <PhoneOutgoing className="w-3 h-3" /> داخل النافذة — يبدأ الاتصال خلال لحظات
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {['draft', 'paused'].includes(c.status) && (
                      <Button variant="brand" size="sm" className="gap-1"
                        onClick={() => act(() => api.startCampaign(companyId, c.id), 'بدأت الحملة')}>
                        <Play className="w-3 h-3" /> تشغيل
                      </Button>
                    )}
                    {c.status === 'running' && (
                      <>
                        <Button variant="ghost" size="sm" className="gap-1" title="شغّل تحديث الآن واعرف السبب"
                          onClick={() => runNow(c)}>
                          <Zap className="w-3 h-3" /> شغّل الآن
                        </Button>
                        <Button variant="secondary" size="sm" className="gap-1"
                          onClick={() => act(() => api.pauseCampaign(companyId, c.id), 'توقفت مؤقتاً')}>
                          <Pause className="w-3 h-3" /> إيقاف
                        </Button>
                      </>
                    )}
                    {!['completed', 'cancelled'].includes(c.status) && (
                      <Button variant="ghost" size="sm" className="gap-1 text-rose-600"
                        onClick={() => setCancelOf(c)}>
                        <XCircle className="w-3 h-3" /> إلغاء
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setDetailOf(c)} className="gap-1">
                      التفاصيل
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setReportOf(c)} className="gap-1">
                      <BarChart3 className="w-3 h-3" /> التقرير <ChevronLeft className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
                {/* progress */}
                <div className="mt-4">
                  <div className="flex items-center justify-between text-[11px] text-ink-500 mb-1">
                    <span>{d} من {t} ({pct}%)</span>
                    <span className="flex gap-2">
                      {Object.entries(c.stats || {}).map(([k, n]) => (
                        <span key={k}>{CONTACT_META[k]?.label || k}: <b className="tabular-nums">{n}</b></span>
                      ))}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-ink-100 overflow-hidden">
                    <div className="h-full bg-gradient-to-l from-brand-400 to-brand-600 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <CreateCampaignModal open={createOpen} onClose={() => setCreateOpen(false)} companyId={companyId}
        onCreated={() => { setCreateOpen(false); load(); }} push={push} />

      <CampaignDetailModal open={!!detailOf} onClose={() => setDetailOf(null)} companyId={companyId} campaign={detailOf} />

      <ConfirmDialog open={!!cancelOf} onClose={() => setCancelOf(null)}
        onConfirm={() => { act(() => api.cancelCampaign(companyId, cancelOf.id), 'أُلغيت الحملة'); setCancelOf(null); }}
        confirmVariant="danger" confirmLabel="نعم، ألغِ"
        title={`إلغاء ${cancelOf?.name}؟`}
        message="ستتوقف كل الاتصالات المتبقية نهائياً. لا يمكن التراجع." />
    </div>
  );
}

// Parse an imported CSV/text file into "phone,name" lines the backend already
// understands. Handles a header row, quoted fields, and BOM, and finds the
// phone + name columns by content rather than assuming a fixed order — so a
// sheet exported from anywhere Just Works.
function parseCsvToLines(text) {
  const raw = String(text || '').replace(/^﻿/, '');           // strip BOM
  const rows = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(splitCsvRow);
  if (!rows.length) return { lines: '', count: 0 };

  const phoneLike = (v) => /[+0-9][0-9\s()-]{6,}/.test(String(v || ''));
  // Detect a header: first row has no phone-looking cell.
  const hasHeader = !rows[0].some(phoneLike);
  let phoneCol = 0, nameCol = 1;
  if (hasHeader) {
    const head = rows[0].map((h) => h.toLowerCase());
    const pi = head.findIndex((h) => /phone|جوال|رقم|mobile|tel|هاتف/.test(h));
    const ni = head.findIndex((h) => /name|اسم|عميل|client/.test(h));
    if (pi >= 0) phoneCol = pi;
    if (ni >= 0) nameCol = ni;
  } else {
    // No header — pick the phone column by content from the first data row.
    const pi = rows[0].findIndex(phoneLike);
    if (pi >= 0) { phoneCol = pi; nameCol = pi === 0 ? 1 : 0; }
  }

  const out = [];
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const phone = (r[phoneCol] || '').trim();
    if (!phone) continue;
    const name = (r[nameCol] || '').trim();
    out.push(name ? `${phone},${name}` : phone);
  }
  return { lines: out.join('\n'), count: out.length };
}

// Minimal CSV field splitter: handles "quoted, fields" and doubled quotes.
function splitCsvRow(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function CreateCampaignModal({ open, onClose, companyId, onCreated, push }) {
  const [name, setName] = useState('');
  const [numbersText, setNumbersText] = useState('');
  const [importInfo, setImportInfo] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // Times as "HH:MM" strings — native, clean, minute-precision.
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('21:00');
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [saving, setSaving] = useState(false);

  const lines = numbersText.split('\n').filter((l) => l.trim()).length;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);

  const importFile = async (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { push('الملف كبير جداً (الحد ٥ ميجابايت)', 'error'); return; }
    try {
      const text = await file.text();
      const { lines: parsed, count } = parseCsvToLines(text);
      if (!count) { push('لم يُعثر على أرقام في الملف', 'error'); return; }
      // Append to whatever is already there so import + manual can be combined.
      setNumbersText((prev) => (prev.trim() ? `${prev.trim()}\n${parsed}` : parsed));
      setImportInfo({ file: file.name, count });
      push(`تم استيراد ${count} رقم من ${file.name}`, 'success');
    } catch { push('تعذّرت قراءة الملف', 'error'); }
  };

  const create = async () => {
    setSaving(true);
    try {
      const r = await api.createCampaign(companyId, {
        name, numbersText,
        startHour: sh, startMinute: sm, endHour: eh, endMinute: em,
        maxConcurrent, maxAttempts,
      });
      let msg = `أُنشئت الحملة (${r.contacts} رقم صالح)`;
      if (r.rejectedCount) msg += ` · ${r.rejectedCount} رقم غير صالح تم تجاهله`;
      if (r.duplicates)    msg += ` · ${r.duplicates} مكرر`;
      push(msg, r.rejectedCount ? 'warning' : 'success');
      setName(''); setNumbersText(''); setImportInfo(null);
      onCreated();
    } catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="حملة صادرة جديدة" size="lg"
      description="الوكيل سيتصل بكل رقم داخل النافذة الزمنية بالسيناريو المفعّل."
      footer={<>
        <Button variant="brand" onClick={create} loading={saving} disabled={!name.trim() || !lines}>إنشاء ({lines} رقم)</Button>
        <Button variant="ghost" onClick={onClose}>إلغاء</Button>
      </>}>
      <div className="space-y-4">
        <div>
          <Label>اسم الحملة</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: عملاء معرض الرياض" />
        </div>

        {/* CSV import dropzone */}
        <div>
          <Label>قائمة الأرقام</Label>
          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); importFile(e.dataTransfer.files?.[0]); }}
            className={`flex items-center justify-center gap-2 h-20 rounded-xl border-2 border-dashed cursor-pointer transition-colors
              ${dragOver ? 'border-brand-400 bg-brand-50' : 'border-ink-200 bg-ink-50/40 hover:border-ink-300'}`}>
            <FileUp className="w-4 h-4 text-ink-400" />
            <span className="text-[12.5px] text-ink-600">
              {importInfo ? `${importInfo.file} — ${importInfo.count} رقم` : 'استورد ملف CSV / Excel (اسحبه هنا أو اضغط للاختيار)'}
            </span>
            <input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden"
              onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <p className="text-[10.5px] text-ink-400 mt-1">
            الأعمدة المتوقعة: رقم الجوال (والاسم اختياري). يتعرّف تلقائياً على صف العناوين.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label>أو الصق الأرقام يدوياً</Label>
            {lines > 0 && <span className="text-[10.5px] text-ink-500 tabular-nums">{lines} سطر</span>}
          </div>
          <textarea value={numbersText}
            onChange={(e) => { setNumbersText(e.target.value); setImportInfo(null); }}
            rows={5} dir="ltr"
            placeholder={'+966501234567,أبو خالد\n0559876543,أم فهد\n+966512345678'}
            className="w-full px-3 py-2 bg-white border border-ink-200 rounded-xl text-[13px] font-mono focus-ring" />
          <p className="text-[10.5px] text-ink-400 mt-1">تُقبل الصيغ: ‎+9665xxxxxxxx‎ أو 05xxxxxxxx — المكرر والأرقام غير الصالحة تُحذف تلقائياً.</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <TimeField label="من الساعة" value={startTime} set={setStartTime} />
          <TimeField label="إلى الساعة" value={endTime} set={setEndTime} />
          <NumField label="مكالمات متزامنة" value={maxConcurrent} set={setMaxConcurrent} min={1} max={10} />
          <NumField label="محاولات لكل رقم" value={maxAttempts} set={setMaxAttempts} min={1} max={5} />
        </div>
        <p className="text-[10.5px] text-ink-400 -mt-1">النافذة بتوقيت السعودية. لو وقت البداية بعد النهاية تُعتبر نافذة ليلية تمتد لليوم التالي.</p>
      </div>
    </Modal>
  );
}

function TimeField({ label, value, set }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type="time" value={value} onChange={(e) => set(e.target.value || '00:00')} dir="ltr" className="tabular-nums" />
    </div>
  );
}

function NumField({ label, value, set, min, max }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type="number" min={min} max={max} value={value}
        onChange={(e) => set(Math.min(max, Math.max(min, Number(e.target.value) || min)))} dir="ltr" />
    </div>
  );
}

function CampaignDetailModal({ open, onClose, companyId, campaign }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!open || !campaign) { setDetail(null); return; }
    api.getCampaign(companyId, campaign.id).then(setDetail).catch(() => {});
  }, [open, campaign, companyId]);

  if (!campaign) return null;
  return (
    <Modal open={open} onClose={onClose} title={campaign.name} size="lg"
      description="حالة كل رقم في الحملة."
      footer={<Button variant="ghost" onClick={onClose}>إغلاق</Button>}>
      {!detail ? <div className="py-8 text-center text-[13px] text-ink-500">جارٍ التحميل…</div> : (
        <div className="max-h-[420px] overflow-y-auto space-y-1.5">
          {(detail.contacts || []).map((ct) => {
            const meta = CONTACT_META[ct.status] || CONTACT_META.pending;
            return (
              <div key={ct.id} className="flex items-center gap-3 rounded-xl ring-1 ring-ink-100 bg-white px-3 py-2">
                <Users className="w-3.5 h-3.5 text-ink-400 shrink-0" />
                <span className="font-mono text-[12.5px] text-ink-800" dir="ltr">{ct.phone}</span>
                {ct.name && <span className="text-[12.5px] text-ink-600 truncate">{ct.name}</span>}
                <span className="flex-1" />
                {ct.attempts > 0 && <span className="text-[10.5px] text-ink-400">محاولة {ct.attempts}</span>}
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
