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
          title="ما فيه شركات لسه"
          description="أنشئ شركة أولاً من تبويب الشركات قبل ما تعمل سيناريو."
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
          <div className="p-12 text-center text-ink-400 text-[13px]">يحمّل...</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Wand2}
            title={tab === 'active' ? 'ابدأ بأول سيناريو' : 'ما فيه سيناريوهات محذوفة'}
            description={tab === 'active'
              ? 'كل شركة محتاجة سيناريو على الأقل عشان الـ AI يعرف يرد. اضغط "سيناريو جديد" وخل الـ AI يولّد لك واحد.'
              : 'لما تحذف سيناريو هيظهر هنا قبل ما يتمسح نهائياً.'}
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
        message="السيناريو هيتحذف من القائمة النشطة. تقدر تستعيده من تبويب المحذوفة قبل المسح النهائي."
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
  { id: 'support',     label: 'خدمة العملاء',  body: 'وكيل خدمة عملاء لشركة [اسم الشركة]. يرد على استفسارات العملاء عن الفواتير وحل المشاكل التقنية ومتابعة الطلبات. ينقل المكالمة لموظف بشري لو المشكلة معقدة.' },
  { id: 'booking',     label: 'حجز مواعيد',    body: 'وكيل حجز مواعيد لعيادة طبية في الرياض. يحجز موعد للعميل، يتأكد من رقم تلفونه، ويرسل تأكيد رسالة نصية. لو الطبيب اللي طلبه مش متاح خلال أسبوعين يحوّل للموظف.' },
  { id: 'restaurant',  label: 'حجز مطاعم',     body: 'وكيل حجز طاولات لمطعم في جدة. يأخذ اسم العميل، عدد الأشخاص، الوقت المفضل، وأي طلبات خاصة. يؤكد توافر الطاولة ويرسل تأكيد.' },
  { id: 'sales',       label: 'مبيعات',         body: 'وكيل مبيعات لمنتج SaaS بالعربية. يجمع معلومات الـ lead (الاسم، الشركة، حجم الفريق، الميزانية المتوقعة)، يحدد قابلية الـ lead، ويحجز ديمو مع فريق المبيعات.' },
];

const INCLUDE_HINTS = [
  { icon: Bot,        label: 'الدور',       hint: 'ايه نوع الوكيل ووظيفته الأساسية؟' },
  { icon: Target,     label: 'الهدف',       hint: 'ايه اللي المفروض يحققه في المكالمة؟' },
  { icon: Type,       label: 'النبرة',      hint: 'إزاي يتكلم — رسمي، ودود، مختصر؟' },
  { icon: Hash,       label: 'بيانات الإدخال', hint: 'متغيرات معروفة قبل المكالمة (اسم العميل، رقم الحساب...)' },
  { icon: ListChecks, label: 'بيانات للجمع', hint: 'إيه اللي محتاجه يكتشفه أثناء المكالمة؟' },
  { icon: AlertTriangle, label: 'حالات التحويل', hint: 'إمتى يحوّل لإنسان؟' },
  { icon: Wrench,     label: 'الأدوات',     hint: 'إنهاء المكالمة، تذاكر، تحويلات...' },
];

function ScenarioCreatePage({ companyId, onBack, onGenerating }) {
  const [description, setDescription] = useState('');
  const [language, setLanguage]       = useState('ar');
  const remaining = 10000 - description.length;
  const ready = description.trim().length >= 20;

  return (
    <div>
      <TopBar
        title="سيناريو جديد بالـ AI"
        subtitle="اوصف الـ agent بالعامي وخلّي gpt-4o-mini يبنيه لك"
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
          <h1 className="text-[24px] font-bold text-ink-900 tracking-tight">أي وكيل صوتي عاوز تبنيه؟</h1>
          <p className="mt-2 text-[14px] text-ink-500 max-w-xl mx-auto">
            اوصف اللي عاوزه الـ agent يعمله، والـ AI هيولّد لك سيناريو كامل: رسالة افتتاحية، instructions، معايير نجاح.
          </p>
        </div>

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
                placeholder={"# الدور: ممثل خدمة عملاء لشركة اتصالات\n# الهدف: حل استفسارات الفواتير، مشاكل الحساب، طلبات الخدمة\n# النبرة: مهني، صبور، ودود، يتكلم اللهجة السعودية النجدية\n\n# بيانات الإدخال (معروفة قبل المكالمة):\n- customer_name: اسم العميل\n- account_number: رقم حسابه\n- account_balance: الرصيد الحالي\n\n# بيانات للجمع:\n- طبيعة الاستفسار (فاتورة، تقنية، تغيير خدمة)\n- تفاصيل المشكلة والحل اللي قدمته\n- وقت مفضل لمعاودة الاتصال (اختياري)\n\n# قواعد التحويل:\n- لمشاكل الدفع فوق 500 ريال حوّل لبشري\n- لمشاكل تقنية ما اتحلتش بعد محاولتين"}
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
                  : <>اكتب 20 حرف على الأقل عشان تقدر تولّد</>}
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
          <h1 className="text-[26px] font-bold text-ink-900 tracking-tight">جاري توليد السيناريو</h1>
          <p className="mt-2 text-[14px] text-ink-500">عادةً ياخد من 30 إلى 90 ثانية</p>
          <div className="mt-5 inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-xl text-[12px] text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5" />
            ابقى على الصفحة لحد ما الـ generation يخلص
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
        name              : scenario.name,
        firstMessage      : scenario.firstMessage,
        instructionPrompt : scenario.instructionPrompt,
        successCriteria   : scenario.successCriteria,
        isActive          : scenario.isActive,
        language          : scenario.language,
      });
      setScenario(updated);
      setDirty(false);
      push('تم الحفظ', 'success');
    } catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  if (!scenario) {
    return <div className="p-10 text-center text-ink-400">يحمّل السيناريو...</div>;
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
    </div>
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

      {/* ─── First message ─── */}
      <Card>
        <div className="flex items-start justify-between mb-2">
          <div>
            <Label className="!mb-0">الرسالة الافتتاحية</Label>
            <p className="text-[12px] text-ink-500 mt-1 max-w-2xl">
              ده اللي الـ agent يقوله أول ما المكالمة تبدأ. تقدر تستخدم متغيرات زي {'{'}{'{'} customer_name {'}'}{'}'} هتتعبّى بالقيم الفعلية وقت المكالمة.
            </p>
          </div>
          <button
            onClick={() => update({ firstMessage: scenario.firstMessage ? '' : 'مرحباً {{customer_name}}، معك {{agent_name}}.' })}
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

      {/* ─── Instruction prompt ─── */}
      <Card>
        <Label hint="تعليمات السلوك بالتفصيل — أقسام، نبرة، خطوات الحوار">Prompt</Label>
        <Textarea
          value={scenario.instructionPrompt}
          onChange={(e) => update({ instructionPrompt: e.target.value })}
          rows={16}
          className="font-mono text-[12.5px] leading-relaxed"
        />
      </Card>

      {/* ─── Template variables ─── */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-[14px] font-semibold text-ink-900">متغيرات القالب</h3>
            <p className="text-[12px] text-ink-500 mt-0.5">اتعرف عليها تلقائياً من اللي كاتبه فوق</p>
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
            مفيش متغيرات لسه — استخدم {'{'}{'{'} variable_name {'}'}{'}'} في الـ prompt أو الرسالة الافتتاحية
          </div>
        )}
      </Card>

      {/* ─── Success criteria ─── */}
      <Card>
        <Label hint="اللي بيحدّد لو الـ AI نجح في المكالمة">معايير النجاح</Label>
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
              ضيف معيار واحد على الأقل عشان نعرف نقيس النجاح
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
        placeholder="مثال: تم تحديد نوع الاستفسار وجمع بيانات العميل"
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
              لما يكون نشط، الـ agent بيستخدم هذا السيناريو في كل مكالمة وشات.
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
            <h3 className="text-[14px] font-semibold text-ink-900">قواعد المعرفة</h3>
            <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
              الـ agent بيستخدم قاعدة المعرفة المرفوعة في الشركة تلقائياً (تبويب "ملفات الـ RAG" داخل بيانات الشركة).
              ربط KB منفصلة بكل سيناريو هييجي في تحديث قريب.
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
