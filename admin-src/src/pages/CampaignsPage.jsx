import { useEffect, useState, useCallback } from 'react';
import { PhoneOutgoing, Plus, Play, Pause, XCircle, RefreshCw, Users, ChevronLeft } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { Input, Label } from '../components/ui/Input';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { relTime } from '../lib/utils';

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

export function CampaignsPage({ pinnedCompanyId }) {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(pinnedCompanyId || null);
  const [campaigns, setCampaigns] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOf, setDetailOf] = useState(null);
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

  const total = (c) => Object.values(c.stats || {}).reduce((s, n) => s + n, 0);
  const done  = (c) => (c.stats?.completed || 0) + (c.stats?.no_answer || 0) + (c.stats?.failed || 0) + (c.stats?.cancelled || 0);

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
                      {t} رقم · نافذة {c.start_hour}:00–{c.end_hour}:00 · تزامن {c.max_concurrent} · محاولات {c.max_attempts} · {relTime(c.created_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {['draft', 'paused'].includes(c.status) && (
                      <Button variant="brand" size="sm" className="gap-1"
                        onClick={() => act(() => api.startCampaign(companyId, c.id), 'بدأت الحملة')}>
                        <Play className="w-3 h-3" /> تشغيل
                      </Button>
                    )}
                    {c.status === 'running' && (
                      <Button variant="secondary" size="sm" className="gap-1"
                        onClick={() => act(() => api.pauseCampaign(companyId, c.id), 'توقفت مؤقتاً')}>
                        <Pause className="w-3 h-3" /> إيقاف
                      </Button>
                    )}
                    {!['completed', 'cancelled'].includes(c.status) && (
                      <Button variant="ghost" size="sm" className="gap-1 text-rose-600"
                        onClick={() => setCancelOf(c)}>
                        <XCircle className="w-3 h-3" /> إلغاء
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setDetailOf(c)} className="gap-1">
                      التفاصيل <ChevronLeft className="w-3 h-3" />
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

function CreateCampaignModal({ open, onClose, companyId, onCreated, push }) {
  const [name, setName] = useState('');
  const [numbersText, setNumbersText] = useState('');
  const [startHour, setStartHour] = useState(10);
  const [endHour, setEndHour] = useState(21);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [saving, setSaving] = useState(false);

  const lines = numbersText.split('\n').filter((l) => l.trim()).length;

  const create = async () => {
    setSaving(true);
    try {
      const r = await api.createCampaign(companyId, { name, numbersText, startHour, endHour, maxConcurrent, maxAttempts });
      push(`أُنشئت الحملة (${r.contacts} رقم صالح)`, 'success');
      setName(''); setNumbersText('');
      onCreated();
    } catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="حملة صادرة جديدة" size="lg"
      description="الوكيل سيتصل بكل رقم داخل النافذة الزمنية بالسيناريو المفعّل."
      footer={<>
        <Button variant="brand" onClick={create} loading={saving} disabled={!name.trim() || !lines}>إنشاء ({lines} سطر)</Button>
        <Button variant="ghost" onClick={onClose}>إلغاء</Button>
      </>}>
      <div className="space-y-4">
        <div>
          <Label>اسم الحملة</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: عملاء معرض الرياض" />
        </div>
        <div>
          <Label>الأرقام (سطر لكل رقم — «رقم» أو «رقم,اسم»)</Label>
          <textarea value={numbersText} onChange={(e) => setNumbersText(e.target.value)}
            rows={7} dir="ltr"
            placeholder={'+966501234567,أبو خالد\n0559876543,أم فهد\n+966512345678'}
            className="w-full px-3 py-2 bg-white border border-ink-200 rounded-xl text-[13px] font-mono focus-ring" />
          <p className="text-[10.5px] text-ink-400 mt-1">تُقبل الصيغ: ‎+9665xxxxxxxx‎ أو 05xxxxxxxx — المكرر يُحذف تلقائياً.</p>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <NumField label="من الساعة" value={startHour} set={setStartHour} min={0} max={23} />
          <NumField label="إلى الساعة" value={endHour} set={setEndHour} min={0} max={23} />
          <NumField label="مكالمات متزامنة" value={maxConcurrent} set={setMaxConcurrent} min={1} max={10} />
          <NumField label="محاولات لكل رقم" value={maxAttempts} set={setMaxAttempts} min={1} max={5} />
        </div>
      </div>
    </Modal>
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
