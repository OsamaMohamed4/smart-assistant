import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Sparkles, Trash2, Eye, Pencil, ArrowLeft, CheckCircle2, XCircle,
  FileText, Loader2, RefreshCw, Save, MessageSquare, Settings2, Globe2,
  X, ChevronLeft, Wand2, BookOpen, Bot, Type, Target, AlertTriangle,
  Wrench, ListChecks, Lightbulb, Cog, Hash,
} from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Input, Label, Textarea } from '../components/ui/Input';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtDate } from '../lib/utils';

// Top-level Scenarios surface. Mirrors sarj's layout: List → Create-with-AI →
// generation progress → Edit. View transitions are local component state so
// the page works inside the SPA without a router library.
export function ScenariosPage({ user, pinnedCompanyId }) {
  const [view, setView]             = useState({ name: 'list' });
  const [companies, setCompanies]   = useState([]);
  const [companyId, setCompanyId]   = useState(pinnedCompanyId || null);

  // Resolve which company we're operating against. Workspace mode pins it;
  // otherwise superadmin gets a switcher and defaults to the first company.
  useEffect(() => {
    if (pinnedCompanyId) { setCompanyId(pinnedCompanyId); return; }
    api.listCompanies().then((cs) => {
      setCompanies(cs || []);
      if (!cs?.length) return;
      setCompanyId((curr) => curr || cs[0].id);
    }).catch(() => {});
  }, [pinnedCompanyId]);

  if (!companyId) {
    return (
      <div className="p-10">
        <EmptyState
          icon={FileText}
          title="لا توجد شركات"
          description="أنشئ شركة أولاً من تبويب الشركات."
        />
      </div>
    );
  }

  if (view.name === 'create') {
    return (
      <ScenarioCreatePage
        companyId={companyId}
        onBack={() => setView({ name: 'list' })}
        onGenerating={(description, language) => setView({ name: 'generating', description, language })}
        onCreated={(scenario) => setView({ name: 'edit', id: scenario.id })}
      />
    );
  }
  if (view.name === 'generating') {
    return (
      <ScenarioGeneratingPage
        companyId={companyId}
        description={view.description}
        language={view.language}
        onDone={(scenario) => setView({ name: 'edit', id: scenario.id })}
        onError={() => setView({ name: 'create' })}
      />
    );
  }
  if (view.name === 'edit') {
    return (
      <ScenarioEditPage
        id={view.id}
        onBack={() => setView({ name: 'list' })}
      />
    );
  }
  return (
    <ScenariosListPage
      companyId={companyId}
      companies={companies}
      pinnedCompanyId={pinnedCompanyId}
      onPickCompany={setCompanyId}
      onCreate={() => setView({ name: 'create' })}
      onOpen={(id) => setView({ name: 'edit', id })}
    />
  );
}

// ─── List view ───────────────────────────────────────────────

function ScenariosListPage({ companyId, companies, pinnedCompanyId, onPickCompany, onCreate, onOpen }) {
  const { push } = useToast();
  const [tab, setTab]     = useState('active');     // active | deleted
  const [rows, setRows]   = useState(null);
  const [search, setSearch] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [company, setCompany] = useState(null);     // for lastSyncedAt comparison

  useEffect(() => {
    setRows(null);
    api.listScenarios(companyId, tab)
      .then(setRows)
      .catch((e) => { push(e.message, 'error'); setRows([]); });
    api.getCompany(companyId).then(setCompany).catch(() => {});
  }, [companyId, tab, refreshKey]);

  // A scenario is "out of sync" with Vapi when it was edited after the last
  // successful publish. We use the active scenario only — the others don't
  // affect what the assistant says until activated + republished.
  const isOutOfSync = (row) => {
    if (!row.isActive) return false;
    if (!company?.assistantId) return true;          // never published at all
    if (!company.lastSyncedAt)  return true;
    return new Date(row.updatedAt) > new Date(company.lastSyncedAt);
  };

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, search]);

  const onToggleActive = async (row) => {
    try {
      await api.activateScenario(row.id, !row.isActive);
      setRefreshKey((k) => k + 1);
      push(row.isActive ? 'تم إيقاف السيناريو' : 'تم تفعيل السيناريو', 'success');
    } catch (e) { push(e.message, 'error'); }
  };
  const onDelete = async () => {
    if (!confirmDel) return;
    try {
      await api.deleteScenario(confirmDel.id);
      push('تم حذف السيناريو', 'success');
      setRefreshKey((k) => k + 1);
    } catch (e) { push(e.message, 'error'); }
    finally { setConfirmDel(null); }
  };

  return (
    <div>
      <TopBar
        title="السيناريوهات"
        subtitle={rows ? `${rows.length} سيناريو` : 'جاري التحميل...'}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="ابحث بالاسم..."
        right={
          <div className="flex items-center gap-2">
            {!pinnedCompanyId && companies.length > 1 && (
              <select
                value={companyId}
                onChange={(e) => onPickCompany(e.target.value)}
                className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring focus:border-ink-300"
              >
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <Button variant="brand" onClick={onCreate} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
              سيناريو جديد
            </Button>
          </div>
        }
      />

      <div className="px-8 py-7">
        {/* ─── Tabs (Active / Recently Deleted) ─── */}
        <div className="flex items-center gap-1 mb-5 border-b border-ink-100">
          {[
            { id: 'active',  label: 'النشطة' },
            { id: 'deleted', label: 'المحذوفة مؤخراً' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'px-4 h-10 text-[13px] font-medium border-b-2 -mb-px transition-colors',
                tab === t.id
                  ? 'border-ink-900 text-ink-900'
                  : 'border-transparent text-ink-500 hover:text-ink-800',
              )}
            >
              {t.label}
            </button>
          ))}
          <div className="flex-1" />
        </div>

        {/* ─── Table ─── */}
        {!filtered ? (
          <div className="p-12 text-center text-ink-400 text-[13px]">جارٍ التحميل...</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Wand2}
            title={tab === 'active' ? 'ابدأ بأول سيناريو' : 'لا توجد سيناريوهات محذوفة'}
            description={tab === 'active'
              ? 'كل شركة تحتاج سيناريو واحد على الأقل ليرد الـ AI.'
              : 'السيناريوهات المحذوفة تظهر هنا قبل المسح النهائي.'}
            action={tab === 'active' && (
              <Button variant="brand" onClick={onCreate} className="gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> سيناريو جديد
              </Button>
            )}
          />
        ) : (
          <div className="bg-white border border-ink-100 rounded-2xl overflow-hidden shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full text-right" dir="rtl">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50/60 text-[11px] uppercase font-semibold text-ink-500 tracking-wider">
                    <Th>الاسم</Th>
                    <Th>اللغات</Th>
                    <Th>الحالة</Th>
                    <Th>الإنشاء</Th>
                    <Th>آخر تعديل</Th>
                    <Th>معايير النجاح</Th>
                    <Th className="text-left">الإجراءات</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-ink-50/40 transition-colors">
                      <td className="px-4 py-3.5">
                        <button
                          onClick={() => onOpen(r.id)}
                          className="text-right text-[13.5px] font-semibold text-ink-900 hover:text-brand-700 transition-colors"
                        >
                          {r.name}
                        </button>
                      </td>
                      <td className="px-4 py-3.5">
                        <LangChip lang={r.language} />
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex flex-col items-end gap-1">
                          {r.isActive
                            ? <Badge tone="success" dot>نشط</Badge>
                            : <Badge tone="neutral" dot>غير نشط</Badge>}
                          {isOutOfSync(r) && (
                            <Badge tone="warning" className="!text-[10px]">تغييرات غير منشورة</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-[12.5px] text-ink-600 tabular-nums whitespace-nowrap">
                        {fmtDate(r.createdAt)}
                      </td>
                      <td className="px-4 py-3.5 text-[12.5px] text-ink-600 tabular-nums whitespace-nowrap">
                        {fmtDate(r.updatedAt)}
                      </td>
                      <td className="px-4 py-3.5">
                        {r.successCriteria?.length
                          ? <Badge tone="info">{r.successCriteria.length} معيار</Badge>
                          : <span className="text-ink-400 text-[12px]">—</span>}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5 justify-end">
                          <IconButton title="عرض/تعديل" onClick={() => onOpen(r.id)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </IconButton>
                          <IconButton
                            title={r.isActive ? 'إيقاف' : 'تفعيل'}
                            tone={r.isActive ? 'amber' : 'emerald'}
                            onClick={() => onToggleActive(r)}
                          >
                            {r.isActive ? <XCircle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                          </IconButton>
                          <IconButton title="حذف" tone="rose" onClick={() => setConfirmDel(r)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        onConfirm={onDelete}
        confirmVariant="danger"
        confirmLabel="حذف"
        title={`حذف "${confirmDel?.name}"؟`}
        message="يمكنك استعادته من تبويب المحذوفة قبل المسح النهائي."
      />
    </div>
  );
}

function Th({ children, className }) {
  return <th className={cn('px-4 py-3 text-right font-semibold whitespace-nowrap', className)}>{children}</th>;
}

function IconButton({ children, onClick, title, tone }) {
  const toneCls = {
    amber  : 'hover:text-amber-700 hover:bg-amber-50',
    emerald: 'hover:text-emerald-700 hover:bg-emerald-50',
    rose   : 'hover:text-rose-700 hover:bg-rose-50',
  }[tone] || 'hover:text-ink-900 hover:bg-ink-100';
  return (
    <button onClick={onClick} title={title}
      className={cn('w-7 h-7 rounded-md text-ink-500 flex items-center justify-center transition-colors', toneCls)}>
      {children}
    </button>
  );
}

function LangChip({ lang }) {
  const map = { ar: 'العربية', en: 'English' };
  return (
    <Badge tone="brand" className="!text-[10.5px] !py-0.5">{map[lang] || lang}</Badge>
  );
}

// ─── Create with AI page ─────────────────────────────────────

const QUICK_STARTS = [
  { id: 'support',     label: 'خدمة العملاء',  body: 'وكيل خدمة عملاء لشركة [اسم الشركة]. يرد على استفسارات العملاء عن الفواتير، يحل المشاكل التقنية، ويتابع الطلبات. يحوّل المكالمة لموظف عند المشاكل المعقدة.' },
  { id: 'booking',     label: 'حجز مواعيد',    body: 'وكيل حجز مواعيد لعيادة طبية في الرياض. يحجز الموعد للعميل، يتحقق من رقم جواله، ويرسل رسالة تأكيد. يحوّل للموظف إذا كان الطبيب غير متاح خلال أسبوعين.' },
  { id: 'restaurant',  label: 'حجز مطاعم',     body: 'وكيل حجز طاولات لمطعم في جدة. يأخذ اسم العميل، عدد الأشخاص، الوقت المفضل، وأي طلبات خاصة. يؤكد توفر الطاولة ويرسل التأكيد.' },
  { id: 'sales',       label: 'مبيعات',         body: 'وكيل مبيعات لمنتج SaaS بالعربية. يجمع معلومات العميل المحتمل (الاسم، الشركة، حجم الفريق، الميزانية)، يحدّد جودته، ويحجز عرضاً تجريبياً.' },
];

const INCLUDE_HINTS = [
  { icon: Bot,        label: 'الدور',         hint: 'نوع الوكيل ووظيفته الأساسية.' },
  { icon: Target,     label: 'الهدف',         hint: 'ما الذي يجب تحقيقه في المكالمة.' },
  { icon: Type,       label: 'النبرة',        hint: 'رسمي، ودود، مختصر.' },
  { icon: Hash,       label: 'بيانات الإدخال', hint: 'متغيرات معروفة قبل المكالمة.' },
  { icon: ListChecks, label: 'بيانات للجمع',  hint: 'ما يجب اكتشافه خلال المكالمة.' },
  { icon: AlertTriangle, label: 'حالات التحويل', hint: 'متى يحوّل لإنسان.' },
  { icon: Wrench,     label: 'الأدوات',       hint: 'إنهاء المكالمة، تذاكر، تحويلات.' },
];

function ScenarioCreatePage({ companyId, onBack, onGenerating, onCreated }) {
  const { push } = useToast();
  const [description, setDescription] = useState('');
  const [language, setLanguage]       = useState('ar');
  const [templates, setTemplates]     = useState([]);
  const [creating, setCreating]       = useState(false);
  const remaining = 10000 - description.length;
  const ready = description.trim().length >= 20;

  useEffect(() => { api.scenarioTemplates().then(setTemplates).catch(() => {}); }, []);

  const useTemplate = async (t) => {
    if (creating) return;
    setCreating(true);
    try {
      const sc = await api.createScenario(companyId, {
        name                : t.name,
        description         : t.description,
        firstMessage        : t.firstMessage,
        firstMessageInbound : t.firstMessageInbound,
        instructionPrompt   : t.instructionPrompt,
        isActive            : false,
      });
      onCreated(sc);
    } catch (e) { push(e.message, 'error'); setCreating(false); }
  };

  return (
    <div>
      <TopBar
        title="سيناريو جديد"
        subtitle="صف الوكيل بكلماتك، والـ AI يولّد السيناريو."
        right={
          <Button variant="ghost" onClick={onBack} className="gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" /> رجوع للقائمة
          </Button>
        }
      />

      <div className="px-8 py-7 max-w-6xl mx-auto">
        <div className="text-center mb-7">
          <div className="inline-flex w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-400 to-accent-violet items-center justify-center shadow-pop mb-4">
            <Sparkles className="w-6 h-6 text-white" strokeWidth={2} />
          </div>
          <h1 className="text-[24px] font-bold text-ink-900 tracking-tight">أي وكيل صوتي تريد بناءه؟</h1>
          <p className="mt-2 text-[14px] text-ink-500 max-w-xl mx-auto">
            صف المهمة، والـ AI يولّد سيناريو كاملاً: رسالة افتتاحية، تعليمات، ومعايير نجاح.
          </p>
        </div>

        {/* ─── Vetted templates (clean, lint-safe starting points) ─── */}
        {templates.length > 0 && (
          <div className="mb-6">
            <div className="text-[12px] text-ink-500 mb-2 text-center">أو ابدأ من قالب جاهز (نضيف وجاهز للنطق الصوتي):</div>
            <div className="grid grid-cols-2 gap-3 max-w-3xl mx-auto">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => useTemplate(t)}
                  disabled={creating}
                  className="text-right p-3.5 rounded-xl border border-ink-200 bg-white hover:border-brand-400 hover:bg-brand-50/40 transition-all disabled:opacity-60"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <BookOpen className="w-3.5 h-3.5 text-brand-500" />
                    <span className="text-[13px] font-semibold text-ink-900">{t.name}</span>
                  </div>
                  <p className="text-[11.5px] text-ink-500 leading-relaxed">{t.description}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ─── Quick start chips ─── */}
        <div className="flex items-center justify-center gap-2 flex-wrap mb-6">
          <span className="text-[12px] text-ink-500 ml-2">بداية سريعة:</span>
          {QUICK_STARTS.map((q) => (
            <button
              key={q.id}
              onClick={() => setDescription(q.body)}
              className="h-8 px-3.5 rounded-full bg-white border border-ink-200 hover:border-ink-400 hover:bg-ink-50 text-[12.5px] text-ink-700 transition-all"
            >
              {q.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-5">
          {/* ─── Textarea ─── */}
          <div className="col-span-2">
            <div className="bg-white border border-ink-200 rounded-2xl shadow-card">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 10000))}
                placeholder={"# الدور: ممثل خدمة عملاء لشركة اتصالات\n# الهدف: حل استفسارات الفواتير والمشاكل التقنية\n# النبرة: مهني، صبور، باللهجة السعودية النجدية\n\n# بيانات الإدخال:\n- customer_name\n- account_number\n\n# بيانات للجمع:\n- طبيعة الاستفسار\n- تفاصيل المشكلة\n\n# قواعد التحويل:\n- مشاكل الدفع فوق 500 ريال → حوّل لموظف"}
                rows={16}
                className="w-full resize-y bg-transparent rounded-2xl p-5 text-[13.5px] placeholder:text-ink-400 outline-none font-arabic leading-relaxed min-h-[360px]"
                style={{ direction: 'rtl' }}
              />
            </div>
            <div className="flex items-center justify-between mt-2 px-1">
              <div className={cn('text-[12px] flex items-center gap-1.5',
                ready ? 'text-emerald-600' : 'text-ink-400')}>
                {ready
                  ? <><CheckCircle2 className="w-3.5 h-3.5" /> جاهز للتوليد</>
                  : <>اكتب 20 حرفاً على الأقل</>}
              </div>
              <div className="text-[12px] text-ink-500 tabular-nums">
                {description.length} / 10,000
              </div>
            </div>

            {/* ─── Output language ─── */}
            <div className="mt-5">
              <Label>لغة المخرجات</Label>
              <div className="flex items-center gap-1 bg-ink-50/80 border border-ink-100 rounded-2xl p-1 w-fit">
                {[
                  { v: 'ar', l: 'العربية' },
                  { v: 'en', l: 'English' },
                ].map((opt) => (
                  <button
                    key={opt.v}
                    onClick={() => setLanguage(opt.v)}
                    className={cn(
                      'h-8 px-4 rounded-xl text-[12.5px] font-medium transition-all',
                      language === opt.v
                        ? 'bg-white text-ink-900 shadow-soft ring-1 ring-ink-100'
                        : 'text-ink-600 hover:text-ink-900',
                    )}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
            </div>

            {/* ─── Generate button ─── */}
            <div className="mt-5">
              <Button
                variant="brand" size="lg"
                disabled={!ready}
                onClick={() => onGenerating(description.trim(), language)}
                className="gap-2 w-full"
              >
                <Sparkles className="w-4 h-4" />
                ولّد السيناريو بالـ AI
              </Button>
            </div>
          </div>

          {/* ─── Side panel: What to Include ─── */}
          <div className="col-span-1">
            <div className="bg-white border border-ink-100 rounded-2xl p-5 shadow-card sticky top-24">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-brand-50 text-brand-700 flex items-center justify-center">
                  <Lightbulb className="w-4 h-4" />
                </div>
                <h3 className="text-[14px] font-semibold text-ink-900">حاول تضمّن</h3>
              </div>
              <div className="space-y-2">
                {INCLUDE_HINTS.map((h) => {
                  const Icon = h.icon;
                  return (
                    <div key={h.label} className="flex items-start gap-2.5 p-2 rounded-lg hover:bg-ink-50/60 transition-colors">
                      <div className="w-7 h-7 rounded-lg bg-ink-100 text-ink-600 flex items-center justify-center shrink-0">
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold text-ink-900">{h.label}</div>
                        <p className="text-[11.5px] text-ink-500 mt-0.5 leading-relaxed">{h.hint}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Generating progress page ────────────────────────────────

const GEN_STEPS = [
  { id: 'analyze',    label: 'نحلّل متطلباتك...',         icon: CheckCircle2, delay:  400 },
  { id: 'persona',    label: 'نصمّم شخصية الوكيل...',      icon: Bot,          delay: 2000 },
  { id: 'flow',       label: 'نكتب تدفق المحادثة...',      icon: ListChecks,   delay: 3800 },
  { id: 'language',   label: 'نضبط نمط اللغة...',          icon: Type,         delay: 5400 },
  { id: 'tools',      label: 'نهيّئ الأدوات...',           icon: Cog,          delay: 7000 },
  { id: 'finalize',   label: 'نُنهي السيناريو...',          icon: Target,       delay: 8500 },
];

function ScenarioGeneratingPage({ companyId, description, language, onDone, onError }) {
  const { push } = useToast();
  const [activeIdx, setActiveIdx] = useState(0);
  const [done, setDone]           = useState(false);
  const apiResultRef = useRef(null);

  // Kick off API + step animation simultaneously. We don't fake the wait —
  // the real generation takes 5-15s and the steps fit within that envelope.
  useEffect(() => {
    let cancelled = false;
    const timers = GEN_STEPS.map((step, i) =>
      setTimeout(() => { if (!cancelled) setActiveIdx(i + 1); }, step.delay)
    );

    api.generateScenario(companyId, { description, language })
      .then((scenario) => {
        apiResultRef.current = scenario;
        if (!cancelled) setDone(true);
      })
      .catch((e) => {
        if (cancelled) return;
        push(e.message || 'فشل التوليد', 'error');
        onError();
      });

    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
    };
  }, [companyId, description, language, onDone, onError, push]);

  // Once the steps are visually done AND the API came back, hand off.
  useEffect(() => {
    if (!done) return;
    if (activeIdx < GEN_STEPS.length) {
      // Steps not finished yet — wait for animation to catch up.
      const handoff = setTimeout(() => {
        if (apiResultRef.current) onDone(apiResultRef.current);
      }, 250);
      return () => clearTimeout(handoff);
    }
    if (apiResultRef.current) onDone(apiResultRef.current);
  }, [done, activeIdx, onDone]);

  const progress = Math.min(100, Math.round((activeIdx / GEN_STEPS.length) * 100));

  return (
    <div className="min-h-[calc(100vh-1px)] flex items-center justify-center p-8 bg-gradient-to-br from-ink-50 via-white to-brand-50/30">
      <div className="w-full max-w-xl">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-400 to-accent-violet items-center justify-center shadow-pop mb-5 animate-pulse">
            <Sparkles className="w-7 h-7 text-white" strokeWidth={2} />
          </div>
          <h1 className="text-[26px] font-bold text-ink-900 tracking-tight">جارٍ توليد السيناريو</h1>
          <p className="mt-2 text-[14px] text-ink-500">يستغرق من 30 إلى 90 ثانية.</p>
          <div className="mt-5 inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-xl text-[12px] text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5" />
            ابقَ على الصفحة حتى ينتهي التوليد.
          </div>
        </div>

        <div className="space-y-2.5 mb-6">
          {GEN_STEPS.map((step, i) => {
            const isDone    = i < activeIdx;
            const isActive  = i === activeIdx && !done;
            const isPending = i > activeIdx;
            const Icon = step.icon;
            return (
              <div
                key={step.id}
                className={cn(
                  'flex items-center gap-3 px-4 py-3.5 rounded-2xl border transition-all',
                  isDone    && 'bg-emerald-50/60 border-emerald-200',
                  isActive  && 'bg-brand-50/60  border-brand-300 shadow-soft',
                  isPending && 'bg-ink-50/40    border-ink-100',
                )}
              >
                <div className={cn(
                  'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                  isDone    && 'bg-emerald-500 text-white',
                  isActive  && 'bg-brand-500   text-white',
                  isPending && 'bg-ink-100     text-ink-400',
                )}>
                  {isActive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" strokeWidth={2} />}
                </div>
                <span className={cn(
                  'text-[13.5px] font-medium',
                  isDone    && 'text-emerald-900 line-through opacity-70',
                  isActive  && 'text-ink-900',
                  isPending && 'text-ink-500',
                )}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* progress bar */}
        <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-brand-400 to-accent-violet transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Edit view (Configuration + Scenario tabs) ────────────────

function ScenarioEditPage({ id, onBack }) {
  const { push } = useToast();
  const [scenario, setScenario] = useState(null);
  const [tab, setTab]           = useState('scenario');
  const [saving, setSaving]     = useState(false);
  const [dirty, setDirty]       = useState(false);
  const [testOpen, setTestOpen]       = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  useEffect(() => {
    api.getScenario(id)
      .then(setScenario)
      .catch((e) => push(e.message, 'error'));
  }, [id]);

  const update = (patch) => {
    setScenario((s) => ({ ...s, ...patch }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.updateScenario(id, {
        name                : scenario.name,
        firstMessage        : scenario.firstMessage,
        firstMessageInbound : scenario.firstMessageInbound,
        instructionPrompt   : scenario.instructionPrompt,
        instructionPromptInbound : scenario.instructionPromptInbound || '',
        successCriteria     : scenario.successCriteria,
        isActive            : scenario.isActive,
        language            : scenario.language,
      });
      setScenario(updated);
      setDirty(false);
      push('تم الحفظ', 'success');
    } catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  if (!scenario) {
    return <div className="p-10 text-center text-ink-400">جارٍ التحميل...</div>;
  }

  return (
    <div>
      <TopBar
        title={scenario.name}
        subtitle={`أُنشئ ${fmtDate(scenario.createdAt)} · آخر تعديل ${fmtDate(scenario.updatedAt)}`}
        right={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onBack} className="gap-1.5">
              <ArrowLeft className="w-3.5 h-3.5" /> رجوع
            </Button>
            <Button variant="secondary" onClick={() => setVersionsOpen(true)} className="gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" /> السجل
            </Button>
            <Button variant="secondary" onClick={() => setPreviewOpen(true)} className="gap-1.5">
              <Eye className="w-3.5 h-3.5" /> معاينة التعليمات
            </Button>
            <Button variant="secondary" onClick={() => setTestOpen(true)} className="gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" /> اختبار
            </Button>
            <Button variant="brand" onClick={save} loading={saving} disabled={!dirty} className="gap-1.5">
              <Save className="w-3.5 h-3.5" /> حفظ التغييرات
            </Button>
          </div>
        }
      />

      <div className="px-8 py-7 max-w-5xl mx-auto">
        {/* ─── Tabs ─── */}
        <div className="flex items-center gap-1 bg-ink-50/80 border border-ink-100 rounded-2xl p-1 mb-6 w-fit">
          {[
            { id: 'configuration', label: 'Configuration', icon: Settings2 },
            { id: 'scenario',      label: 'Scenario',      icon: FileText  },
          ].map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'h-9 px-4 rounded-xl flex items-center gap-2 text-[12.5px] font-medium transition-all',
                  active ? 'bg-white text-ink-900 shadow-soft ring-1 ring-ink-100' : 'text-ink-600 hover:text-ink-900',
                )}
              >
                <Icon className={cn('w-3.5 h-3.5', active ? 'text-brand-500' : 'text-ink-500')} />
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'scenario'      && <ScenarioTab scenario={scenario} update={update} />}
        {tab === 'configuration' && <ConfigurationTab scenario={scenario} update={update} />}
      </div>

      <DraftTestModal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        companyId={scenario.companyId}
        instructionPrompt={scenario.instructionPrompt}
      />
      <PromptPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        companyId={scenario.companyId}
        instructionPrompt={scenario.instructionPrompt}
      />
      <VersionsModal
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        scenarioId={id}
        onRestored={(sc) => { setScenario(sc); setDirty(false); setVersionsOpen(false); push('تم الاسترجاع', 'success'); }}
      />
    </div>
  );
}

// Version history: list the last edits and restore any of them (rollback is
// itself snapshotted, so it's safe/undoable). The safety net that lets
// companies edit freely.
function VersionsModal({ open, onClose, scenarioId, onRestored }) {
  const { push } = useToast();
  const [versions, setVersions] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    api.listScenarioVersions(scenarioId)
      .then(setVersions)
      .catch((e) => { push(e.message, 'error'); setVersions([]); });
  }, [open, scenarioId]);

  const restore = async (v) => {
    if (!confirm('استرجاع هذه النسخة؟ سيتم حفظ النص الحالي في السجل أولاً.')) return;
    setBusy(true);
    try {
      const sc = await api.rollbackScenario(scenarioId, v.id);
      onRestored(sc);
    } catch (e) { push(e.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="md" title="سجل الإصدارات"
      description="كل تعديل يُحفظ هنا تلقائياً — تقدر ترجع لأي نسخة سابقة.">
      {!versions ? (
        <div className="text-center py-8 text-ink-400 text-[13px]">جارٍ التحميل…</div>
      ) : versions.length === 0 ? (
        <div className="text-center py-8 text-ink-500 text-[13px]">لا توجد نسخ سابقة بعد. أول تعديل سيُحفظ هنا.</div>
      ) : (
        <div className="space-y-2 max-h-[55vh] overflow-y-auto">
          {versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3 border border-ink-100 rounded-xl px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-ink-800 truncate">{v.name || 'سيناريو'}</div>
                <div className="text-[11px] text-ink-500">
                  {fmtDate(v.created_at)}{v.edited_by ? ` · ${v.edited_by}` : ''} · {v.prompt_len} حرف
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => restore(v)} disabled={busy}>استرجاع</Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// Test the unsaved draft (not the published assistant) against the model + KB.
function DraftTestModal({ open, onClose, companyId, instructionPrompt }) {
  const { push } = useToast();
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [busy, setBusy]         = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { if (open) { setMessages([]); setInput(''); } }, [open]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput('');
    const next = [...messages, { role: 'user', content: msg }];
    setMessages(next);
    setBusy(true);
    try {
      const r = await api.testDraftScenario(companyId, {
        instructionPrompt,
        message: msg,
        history: next.slice(0, -1),
      });
      setMessages((m) => [...m, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: e.message, error: true }]);
      push(e.message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="اختبار المسودّة"
      description="جرّب السيناريو الحالي (غير المنشور) قبل النشر — نفس النص + قاعدة المعرفة.">
      <div ref={scrollRef} className="max-h-[50vh] overflow-y-auto space-y-3 mb-3 pr-1">
        {messages.length === 0 ? (
          <div className="text-center py-8 text-[12.5px] text-ink-400">اكتب رسالة عميل لتجربة رد المساعد.</div>
        ) : messages.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'user' ? 'justify-start' : 'justify-end')}>
            <div className={cn(
              'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap',
              m.role === 'user' ? 'bg-ink-900 text-white'
                : m.error ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200'
                : 'bg-white text-ink-800 ring-1 ring-ink-100',
            )}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="flex justify-end"><div className="bg-white ring-1 ring-ink-100 rounded-2xl px-4 py-3 text-ink-400 text-[13px]">…</div></div>}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
          placeholder="رسالة العميل…"
          disabled={busy}
        />
        <Button variant="brand" onClick={send} loading={busy} disabled={!input.trim()}>إرسال</Button>
      </div>
    </Modal>
  );
}

// Show the exact composed system prompt (scenario + KB + endCall) the assistant
// runs on — removes the "I edit the scenario but Vapi shows something else"
// confusion.
function PromptPreviewModal({ open, onClose, companyId, instructionPrompt }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(true); setData(null);
    api.previewPrompt(companyId, { instructionPrompt })
      .then(setData)
      .catch((e) => setData({ error: e.message }))
      .finally(() => setBusy(false));
  }, [open, companyId, instructionPrompt]);

  return (
    <Modal open={open} onClose={onClose} size="lg" title="معاينة التعليمات النهائية"
      description="هذا بالضبط ما يصل إلى المساعد على Vapi — السيناريو + قاعدة المعرفة + قاعدة الإنهاء.">
      {busy && <div className="text-center py-8 text-ink-400 text-[13px]">جارٍ التحميل…</div>}
      {data?.error && <div className="bg-rose-50 text-rose-700 rounded-xl p-3 text-[13px]">{data.error}</div>}
      {data?.prompt && (
        <div>
          <div className="flex items-center gap-2 mb-2 text-[11.5px] text-ink-500">
            <Badge tone="brand">{data.length} حرف</Badge>
            <Badge tone="neutral">{data.kbChunks} مقطع KB</Badge>
            {data.kbCapped && <Badge tone="warning">قاعدة المعرفة مقصوصة (الحد {data.capChars})</Badge>}
          </div>
          <pre className="max-h-[55vh] overflow-y-auto bg-ink-50 border border-ink-100 rounded-xl p-3.5 text-[12px] leading-relaxed whitespace-pre-wrap font-arabic" dir="rtl">{data.prompt}</pre>
        </div>
      )}
    </Modal>
  );
}

function ScenarioTab({ scenario, update }) {
  // Toggle the primary criterion (one at most)
  const setPrimary = (idx) => update({
    successCriteria: scenario.successCriteria.map((c, i) => ({ ...c, primary: i === idx })),
  });
  const removeCriterion = (idx) => update({
    successCriteria: scenario.successCriteria.filter((_, i) => i !== idx),
  });
  const addCriterion = (text) => {
    if (!text.trim()) return;
    update({
      successCriteria: [...scenario.successCriteria, { text: text.trim(), primary: scenario.successCriteria.length === 0 }],
    });
  };
  const updateCriterionText = (idx, text) => update({
    successCriteria: scenario.successCriteria.map((c, i) => i === idx ? { ...c, text } : c),
  });

  return (
    <div className="space-y-5">
      {/* ─── Name ─── */}
      <Card>
        <Label>اسم السيناريو</Label>
        <Input
          value={scenario.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="مثال: خدمة عملاء شركة الاتصالات"
        />
      </Card>

      {/* ─── First message (outbound) ─── */}
      <Card>
        <div className="flex items-start justify-between mb-2">
          <div>
            <Label className="!mb-0">الرسالة الافتتاحية — مكالمات صادرة</Label>
            <p className="text-[12px] text-ink-500 mt-1 max-w-2xl">
              ما يقوله الوكيل عندما نتصل نحن بالعميل. اسمه معروف، فاستخدم {'{'}{'{'} customer_name {'}'}{'}'}.
            </p>
          </div>
          <button
            onClick={() => update({ firstMessage: scenario.firstMessage ? '' : 'مرحباً {{customer_name}}، معك {{agent_name}} من شركتنا.' })}
            className="text-[11.5px] text-ink-500 hover:text-ink-800"
          >
            {scenario.firstMessage ? 'إفراغ' : 'مثال'}
          </button>
        </div>
        <Textarea
          value={scenario.firstMessage}
          onChange={(e) => update({ firstMessage: e.target.value })}
          rows={3}
          placeholder="مرحباً {{customer_name}}، معك {{agent_name}} من..."
        />
      </Card>

      {/* ─── First message (inbound) ─── */}
      <Card>
        <div className="flex items-start justify-between mb-2">
          <div>
            <Label className="!mb-0">الرسالة الافتتاحية — مكالمات واردة</Label>
            <p className="text-[12px] text-ink-500 mt-1 max-w-2xl">
              ما يقوله الوكيل عندما يتصل العميل بنا. اسمه غير معروف، فلا تستخدم {'{'}{'{'} customer_name {'}'}{'}'}؛ ابدأ بتحية عامة.
            </p>
          </div>
          <button
            onClick={() => update({ firstMessageInbound: scenario.firstMessageInbound ? '' : 'حياك الله، معك {{agent_name}} من شركتنا، كيف يقدر أساعدك؟' })}
            className="text-[11.5px] text-ink-500 hover:text-ink-800"
          >
            {scenario.firstMessageInbound ? 'إفراغ' : 'مثال'}
          </button>
        </div>
        <Textarea
          value={scenario.firstMessageInbound || ''}
          onChange={(e) => update({ firstMessageInbound: e.target.value })}
          rows={3}
          placeholder="حياك الله، معك {{agent_name}} من..."
        />
      </Card>

      {/* ─── Instruction prompt ─── */}
      <Card>
        <Label hint="تعليمات السلوك بالتفصيل — أقسام، نبرة، خطوات الحوار">Prompt</Label>
        <SectionInserter
          onInsert={(header) => update({
            instructionPrompt: (scenario.instructionPrompt || '').replace(/\s*$/, '') + `\n\n${header}\n`,
          })}
        />
        <Textarea
          value={scenario.instructionPrompt}
          onChange={(e) => update({ instructionPrompt: e.target.value })}
          rows={16}
          className="font-mono text-[12.5px] leading-relaxed"
        />
        <LintWarnings text={scenario.instructionPrompt} />
      </Card>

      {/* ─── Optional: separate inbound prompt (Phase 3) ─── */}
      <InboundPromptCard scenario={scenario} update={update} />

      {/* ─── Template variables ─── */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-[14px] font-semibold text-ink-900">متغيرات القالب</h3>
            <p className="text-[12px] text-ink-500 mt-0.5">تُكتشف تلقائياً من النص أعلاه.</p>
          </div>
          <Badge tone="brand">{scenario.variables?.length || 0} متغير</Badge>
        </div>
        {scenario.variables?.length ? (
          <div className="border border-ink-100 rounded-xl overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead className="bg-ink-50/60 text-[11px] uppercase font-semibold text-ink-500 tracking-wider">
                <tr>
                  <th className="text-right px-3 py-2">الاسم</th>
                  <th className="text-right px-3 py-2">النوع</th>
                  <th className="text-right px-3 py-2">مطلوب</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {scenario.variables.map((v) => (
                  <tr key={v.name} className="bg-white">
                    <td className="px-3 py-2.5 font-mono text-ink-800" dir="ltr">{v.name}</td>
                    <td className="px-3 py-2.5 text-ink-600">{v.type === 'global' ? 'عام' : 'نص'}</td>
                    <td className="px-3 py-2.5">
                      {v.required
                        ? <Badge tone="info">مطلوب</Badge>
                        : <span className="text-ink-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12.5px] text-ink-400 text-center py-6 border border-dashed border-ink-200 rounded-xl">
            لا توجد متغيرات. استخدم {'{'}{'{'} variable_name {'}'}{'}'} في الـ prompt أو الرسالة الافتتاحية.
          </div>
        )}
      </Card>

      {/* ─── Success criteria ─── */}
      <Card>
        <Label hint="مقاييس نجاح المكالمة.">معايير النجاح</Label>
        <CriterionAdder onAdd={addCriterion} />
        <div className="mt-3 space-y-2">
          {(scenario.successCriteria || []).map((c, idx) => (
            <div key={idx} className={cn(
              'flex items-start gap-2 p-3 rounded-xl border',
              c.primary ? 'border-brand-300 bg-brand-50/40' : 'border-ink-200 bg-white',
            )}>
              <input
                value={c.text}
                onChange={(e) => updateCriterionText(idx, e.target.value)}
                className="flex-1 bg-transparent text-[13px] outline-none text-ink-800"
                dir="auto"
              />
              {c.primary ? (
                <Badge tone="brand" className="!py-0">أساسي</Badge>
              ) : (
                <button
                  onClick={() => setPrimary(idx)}
                  className="text-[11px] text-ink-500 hover:text-ink-800 px-2"
                >
                  جعله أساسي
                </button>
              )}
              <button
                onClick={() => removeCriterion(idx)}
                className="text-ink-400 hover:text-rose-600 w-6 h-6 flex items-center justify-center"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {!scenario.successCriteria?.length && (
            <div className="text-[12.5px] text-ink-400 text-center py-4">
              أضف معياراً واحداً على الأقل.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function CriterionAdder({ onAdd }) {
  const [text, setText] = useState('');
  return (
    <div className="flex items-center gap-2 mt-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(text); setText(''); } }}
        placeholder="مثال: تم جمع بيانات العميل."
      />
      <Button variant="secondary" onClick={() => { onAdd(text); setText(''); }} disabled={!text.trim()}>
        إضافة
      </Button>
    </div>
  );
}

function ConfigurationTab({ scenario, update }) {
  return (
    <div className="space-y-5">
      <VoiceSettingsCard companyId={scenario.companyId} />
      <EvalsCard companyId={scenario.companyId} />
      <Card>
        <h3 className="text-[14px] font-semibold text-ink-900 mb-3">اللغات المُعدّة</h3>
        <div className="flex flex-wrap items-center gap-2">
          {[
            { v: 'ar', l: 'العربية' },
            { v: 'en', l: 'English' },
          ].map((opt) => {
            const active = scenario.language === opt.v;
            return (
              <button
                key={opt.v}
                onClick={() => update({ language: opt.v })}
                className={cn(
                  'h-9 px-4 rounded-xl text-[12.5px] font-medium border transition-colors',
                  active
                    ? 'bg-brand-50 border-brand-300 text-brand-800'
                    : 'bg-white border-ink-200 text-ink-700 hover:border-ink-300',
                )}
              >
                <span className="ml-1">{opt.l}</span>
                {active && <Badge tone="brand" className="ml-1.5 !text-[9px]">الافتراضية</Badge>}
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-[14px] font-semibold text-ink-900">حالة السيناريو</h3>
            <p className="text-[12px] text-ink-500 mt-0.5">
              عند التفعيل، يستخدمه الوكيل في كل مكالمة وشات.
            </p>
          </div>
          <button
            onClick={() => update({ isActive: !scenario.isActive })}
            className={cn(
              'relative w-12 h-7 rounded-full transition-colors',
              scenario.isActive ? 'bg-emerald-500' : 'bg-ink-200',
            )}
          >
            <span className={cn(
              'absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-soft transition-all',
              scenario.isActive ? 'right-0.5' : 'right-[22px]',
            )} />
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center shrink-0">
            <BookOpen className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <h3 className="text-[14px] font-semibold text-ink-900">قاعدة المعرفة</h3>
            <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
              يستخدم الوكيل ملفات RAG المرفوعة في إعدادات الشركة تلقائياً.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Card({ children }) {
  return (
    <div className="bg-white border border-ink-100 rounded-2xl p-5 shadow-card">
      {children}
    </div>
  );
}

// Lightweight structure helper (Phase 1b) — insert labelled section headers so
// companies write a well-organised prompt without a risky schema split. The
// lint + test + preview + versioning already de-risk free-text editing.
const PROMPT_SECTIONS = [
  '═══ الهوية والدور ═══',
  '═══ أسلوب الحديث ═══',
  '═══ تدفّق الحوار ═══',
  '═══ التعامل مع الاعتراضات ═══',
  '═══ الإغلاق (استدعِ endCall) ═══',
  '═══ قواعد عامة ═══',
];
function SectionInserter({ onInsert }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-2">
      <span className="text-[11px] text-ink-400">إدراج قسم:</span>
      {PROMPT_SECTIONS.map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => onInsert(h)}
          className="h-6 px-2 rounded-md bg-ink-50 border border-ink-200 hover:border-ink-300 text-[10.5px] text-ink-600 transition-colors"
        >
          {h.replace(/═/g, '').trim()}
        </button>
      ))}
    </div>
  );
}

// Optional per-direction inbound prompt. When filled, publishing builds a
// SECOND Vapi assistant for inbound calls (bind the inbound number to it).
// Empty = inbound uses the same prompt as outbound (default).
function InboundPromptCard({ scenario, update }) {
  const [open, setOpen] = useState(!!scenario.instructionPromptInbound);
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-semibold text-ink-900">تعليمات المكالمات الواردة (اختياري)</h3>
          <p className="text-[11.5px] text-ink-500 mt-0.5 leading-relaxed">
            عند تعبئتها، يبني النشر مساعداً منفصلاً للمكالمات الواردة، فاربط الرقم الوارد به. وإن تُركت فارغة، تستخدم المكالمات الواردة نفس تعليمات الصادرة.
          </p>
        </div>
        {!open && !scenario.instructionPromptInbound && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>إضافة</Button>
        )}
      </div>
      {(open || scenario.instructionPromptInbound) && (
        <div className="mt-3">
          <Textarea
            value={scenario.instructionPromptInbound || ''}
            onChange={(e) => update({ instructionPromptInbound: e.target.value })}
            rows={12}
            placeholder="تعليمات خاصة بالمكالمات الواردة فقط…"
            className="font-mono text-[12.5px] leading-relaxed"
          />
          <LintWarnings text={scenario.instructionPromptInbound || ''} />
        </div>
      )}
    </Card>
  );
}

// Company-level voice + model tuning. Saved to the company (not the scenario);
// applied on the next نشر. All values are clamped server-side.
function VoiceSettingsCard({ companyId }) {
  const { push } = useToast();
  const [s, setS]       = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getCompany(companyId)
      .then((c) => setS({
        model: 'gpt-4.1', temperature: 0.3, maxTokens: 400,
        stability: 0.8, optimizeStreamingLatency: 3,
        ...(c.settings || {}),
      }))
      .catch(() => setS({}));
  }, [companyId]);

  const save = async () => {
    setSaving(true);
    try { await api.updateCompanySettings(companyId, s); push('تم حفظ الإعدادات — تظهر بعد النشر', 'success'); }
    catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  if (!s) return null;
  const num = (k) => (e) => setS((x) => ({ ...x, [k]: Number(e.target.value) }));

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold text-ink-900">إعدادات الصوت والموديل</h3>
        <Button variant="brand" size="sm" onClick={save} loading={saving}>حفظ</Button>
      </div>
      <p className="text-[11.5px] text-ink-500 mb-4">إعدادات على مستوى الشركة — تُطبّق بعد الضغط على نشر.</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>معرّف الرقم الصادر (Vapi)</Label>
          <Input
            value={s.outboundPhoneNumberId || ''}
            onChange={(e) => setS((x) => ({ ...x, outboundPhoneNumberId: e.target.value }))}
            placeholder="Phone Number ID للمكالمات الصادرة"
            dir="ltr"
          />
        </div>
        <div>
          <Label>معرّف الرقم الوارد (Vapi)</Label>
          <Input
            value={s.inboundPhoneNumberId || ''}
            onChange={(e) => setS((x) => ({ ...x, inboundPhoneNumberId: e.target.value }))}
            placeholder="للتوثيق — الربط يتم في Vapi"
            dir="ltr"
          />
        </div>
        <div>
          <Label>الموديل</Label>
          <select value={s.model} onChange={(e) => setS((x) => ({ ...x, model: e.target.value }))}
            className="w-full h-10 px-3 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring">
            <option value="gpt-4.1">gpt-4.1 (أعلى جودة — موصى به)</option>
            <option value="gpt-4o">gpt-4o (جودة عالية)</option>
            <option value="gpt-4.1-mini">gpt-4.1-mini (أسرع/أرخص)</option>
            <option value="gpt-4o-mini">gpt-4o-mini (الأسرع)</option>
          </select>
        </div>
        <RangeField label="ثبات الصوت (stability)" value={s.stability ?? 0.8} min={0} max={1} step={0.05} onChange={num('stability')} />
        <RangeField label="حرارة الردود (temperature)" value={s.temperature ?? 0.6} min={0} max={1} step={0.05} onChange={num('temperature')} />
        <RangeField label="سرعة البث (latency 0-4)" value={s.optimizeStreamingLatency ?? 3} min={0} max={4} step={1} onChange={num('optimizeStreamingLatency')} />
        <RangeField label="أقصى طول للرد (tokens)" value={s.maxTokens ?? 200} min={50} max={500} step={10} onChange={num('maxTokens')} />
        <div>
          <Label>رقم التحويل لموظف بشري</Label>
          <Input
            value={s.transferPhoneNumber || ''}
            onChange={(e) => setS((x) => ({ ...x, transferPhoneNumber: e.target.value }))}
            placeholder="+9665xxxxxxxx — فارغ = بدون تحويل"
            dir="ltr"
          />
          <p className="text-[10.5px] text-ink-400 mt-1">عند ضبطه، يقدر الوكيل يحوّل المكالمة لهذا الرقم. حدّد في السيناريو متى يحوّل.</p>
        </div>
        <div>
          <Label>رابط الإشعار (Webhook)</Label>
          <Input
            value={s.webhookUrl || ''}
            onChange={(e) => setS((x) => ({ ...x, webhookUrl: e.target.value }))}
            placeholder="https://... — يُرسل له ملخص كل مكالمة"
            dir="ltr"
          />
          <Input
            value={s.webhookSecret || ''}
            onChange={(e) => setS((x) => ({ ...x, webhookSecret: e.target.value }))}
            placeholder="مفتاح التوقيع (اختياري)"
            dir="ltr"
            className="mt-2"
          />
        </div>
      </div>
    </Card>
  );
}

// Eval harness: golden questions + one-click scoring of the ACTIVE scenario.
// Comparing the last two runs (e.g. active vs draft) is the practical A/B.
function EvalsCard({ companyId }) {
  const { push } = useToast();
  const [questions, setQuestions] = useState([]);
  const [runs, setRuns] = useState([]);
  const [q, setQ] = useState('');
  const [expected, setExpected] = useState('');
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);

  const load = () => {
    api.listEvalQuestions(companyId).then(setQuestions).catch(() => {});
    api.listEvalRuns(companyId).then(setRuns).catch(() => {});
  };
  useEffect(load, [companyId]);

  const addQ = async () => {
    if (!q.trim() || !expected.trim()) return;
    try {
      await api.addEvalQuestion(companyId, { question: q.trim(), expected: expected.trim() });
      setQ(''); setExpected(''); load();
    } catch (e) { push(e.message, 'error'); }
  };

  const run = async () => {
    setRunning(true);
    try {
      const r = await api.runEval(companyId);
      setLastRun(r);
      push(`النتيجة: ${r.score}٪ (${r.correct} صحيحة، ${r.partial} جزئية من ${r.total})`, r.score >= 80 ? 'success' : 'error');
      load();
    } catch (e) { push(e.message, 'error'); }
    finally { setRunning(false); }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[14px] font-semibold text-ink-900">اختبار الجودة (Evals)</h3>
        <Button variant="brand" size="sm" onClick={run} loading={running} disabled={!questions.length}>
          شغّل الاختبار ({questions.length})
        </Button>
      </div>
      <p className="text-[11.5px] text-ink-500 mb-3">
        أسئلة ذهبية بإجابات معتمدة — تُقاس بعد كل تعديل حتى تعرف إن كان السيناريو تحسّن أم ساء.
      </p>

      {runs.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {runs.slice(0, 4).map((r) => (
            <Badge key={r.id} tone={r.score >= 80 ? 'success' : r.score >= 50 ? 'warning' : 'danger'}>
              {r.label === 'draft' ? 'مسودة' : 'المفعّل'}: {r.score}٪ · {fmtDate(r.created_at)}
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-1.5 mb-3 max-h-[180px] overflow-y-auto">
        {questions.map((it) => (
          <div key={it.id} className="flex items-start gap-2 rounded-lg ring-1 ring-ink-100 bg-ink-50/50 px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-ink-800">{it.question}</div>
              <div className="text-[11px] text-ink-500 mt-0.5">المتوقع: {it.expected}</div>
            </div>
            <button onClick={() => api.deleteEvalQuestion(companyId, it.id).then(load)}
              className="text-rose-400 hover:text-rose-600 shrink-0 mt-0.5"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="سؤال يسأله العميل عادة" />
        <div className="flex gap-2">
          <Input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="الإجابة الصحيحة المتوقعة" />
          <Button variant="secondary" size="sm" onClick={addQ} className="shrink-0 h-10">إضافة</Button>
        </div>
      </div>

      {lastRun && (
        <div className="mt-3 space-y-1 max-h-[200px] overflow-y-auto">
          {lastRun.results.map((r, i) => (
            <div key={i} className="text-[11.5px] rounded-lg px-3 py-1.5 ring-1 ring-ink-100 bg-white flex items-start gap-2">
              <Badge tone={r.verdict === 'correct' ? 'success' : r.verdict === 'partial' ? 'warning' : 'danger'}>
                {r.verdict === 'correct' ? 'صحيحة' : r.verdict === 'partial' ? 'جزئية' : 'خاطئة'}
              </Badge>
              <div className="min-w-0">
                <div className="text-ink-800 truncate">{r.question}</div>
                {r.reason && <div className="text-ink-500">{r.reason}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function RangeField({ label, value, min, max, step, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label>{label}</Label>
        <span className="text-[11.5px] font-mono text-ink-600 tabular-nums">{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={onChange}
        className="w-full accent-brand-500" />
    </div>
  );
}

// Live linter shown under the Prompt textarea. Debounces calls to the server
// so a company sees TTS-breaking issues (tashkeel, digits, markdown, English,
// missing endCall) as it types — the same checks that turned "وَكَنْ" into
// "وكنسلاتيا" on a real call.
function LintWarnings({ text }) {
  const [warnings, setWarnings] = useState([]);
  const [checked, setChecked]   = useState(false);

  useEffect(() => {
    if (!text || !text.trim()) { setWarnings([]); setChecked(true); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.lintScenario(text)
        .then((r) => { if (!cancelled) { setWarnings(r.warnings || []); setChecked(true); } })
        .catch(() => { if (!cancelled) setChecked(true); });
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [text]);

  if (!checked) return null;
  if (!warnings.length) {
    return (
      <div className="mt-3 flex items-center gap-2 text-[12px] text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5" />
        لا توجد مشاكل في النص — جاهز للنطق الصوتي.
      </div>
    );
  }

  const TONE = {
    error: 'bg-rose-50 text-rose-800 ring-rose-200',
    warn : 'bg-amber-50 text-amber-900 ring-amber-200',
    info : 'bg-sky-50 text-sky-800 ring-sky-200',
  };
  const errorCount = warnings.filter((w) => w.level === 'error').length;

  return (
    <div className="mt-3 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        فحص النص ({warnings.length}){errorCount ? ' · يوجد خطأ يكسر الصوت' : ''}
      </div>
      {warnings.map((w, i) => (
        <div
          key={i}
          className={cn('flex items-start gap-2 px-3 py-2 rounded-xl ring-1 text-[12.5px] leading-relaxed', TONE[w.level] || TONE.info)}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>
            <span>{w.message}</span>
            {w.count ? <span className="opacity-70"> ({w.count})</span> : null}
            {w.samples?.length ? (
              <span className="opacity-70"> — {w.samples.join('، ')}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
