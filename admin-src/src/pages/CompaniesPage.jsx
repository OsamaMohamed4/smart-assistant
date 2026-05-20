import { useEffect, useMemo, useState } from 'react';
import { Plus, Building2, RefreshCw, ArrowUpRight, Wand2 } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { CompanyCardSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/Modal';
import { CompanyCard } from '../components/companies/CompanyCard';
import { CompanyForm } from '../components/companies/CompanyForm';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtNumber } from '../lib/utils';

export function CompaniesPage({ onPickCompany }) {
  const { push } = useToast();
  const [companies, setCompanies] = useState(null);
  const [search, setSearch]       = useState('');
  const [sort, setSort]           = useState('recent');
  const [formOpen, setFormOpen]   = useState(false);
  const [editing, setEditing]     = useState(null);
  const [saving, setSaving]       = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [bindingId, setBindingId] = useState(null);
  const [deleteOf, setDeleteOf]   = useState(null);
  const [bindOf, setBindOf]       = useState(null);

  const load = async () => {
    try { setCompanies(await api.listCompanies()); }
    catch (e) { push(e.message, 'error'); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!companies) return null;
    const q = search.trim().toLowerCase();
    let arr = q ? companies.filter((c) =>
      c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
    ) : companies.slice();
    if (sort === 'name')   arr.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    if (sort === 'recent') arr.sort((a, b) => (b.stats?.lastActivity || '').localeCompare(a.stats?.lastActivity || ''));
    if (sort === 'busiest') arr.sort((a, b) => (b.stats?.chats||0) + (b.stats?.calls||0)*5 - ((a.stats?.chats||0) + (a.stats?.calls||0)*5));
    return arr;
  }, [companies, search, sort]);

  const totals = useMemo(() => {
    if (!companies) return null;
    return {
      companies: companies.length,
      synced   : companies.filter((c) => c.assistantId).length,
      chats    : companies.reduce((s, c) => s + (c.stats?.chats || 0), 0),
      calls    : companies.reduce((s, c) => s + (c.stats?.calls || 0), 0),
    };
  }, [companies]);

  const onSave = async (data) => {
    setSaving(true);
    try {
      if (editing) {
        const { id, ...patch } = data;
        await api.updateCompany(editing.id, patch);
        push(`تم تحديث ${data.name}`, 'success');
      } else {
        await api.createCompany(data);
        push(`تم إنشاء ${data.name}`, 'success');
      }
      setFormOpen(false); setEditing(null);
      load();
    } catch (e) { push(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const onSync = async (c) => {
    setSyncingId(c.id);
    try {
      await api.syncVapi(c.id);
      push(`نشرنا ${c.name} على Vapi`, 'success');
      load();
    } catch (e) { push(e.message, 'error'); }
    finally { setSyncingId(null); }
  };

  const onBindPhone = async () => {
    if (!bindOf) return;
    setBindingId(bindOf.id);
    try {
      const r = await api.bindPhone(bindOf.id);
      push(`الرقم ${r.phoneNumber} مربوط بـ ${bindOf.name}`, 'success');
      load();
    } catch (e) { push(e.message, 'error'); }
    finally { setBindingId(null); setBindOf(null); }
  };

  const onDelete = async () => {
    if (!deleteOf) return;
    try {
      await api.deleteCompany(deleteOf.id);
      push(`تم حذف ${deleteOf.name}`, 'success');
      load();
    } catch (e) { push(e.message, 'error'); }
    finally { setDeleteOf(null); }
  };

  return (
    <div>
      <TopBar
        title="الشركات"
        subtitle={totals ? `${fmtNumber(totals.companies)} شركة · ${fmtNumber(totals.synced)} منشورة · ${fmtNumber(totals.chats + totals.calls)} تفاعل` : 'جاري التحميل...'}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="ابحث باسم الشركة أو المعرّف"
        right={<>
          <Button variant="secondary" size="md" onClick={load} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
            تحديث
          </Button>
          <Button variant="brand" size="md" onClick={() => { setEditing(null); setFormOpen(true); }} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
            شركة جديدة
          </Button>
        </>}
      />

      <div className="px-8 py-7">
        {/* ─── Hero stats strip ─── */}
        {totals && (
          <div className="grid grid-cols-4 gap-4 mb-6">
            <HeroStat label="إجمالي الشركات" value={fmtNumber(totals.companies)} hint="مفعّلة في النظام" accent="brand" />
            <HeroStat label="منشورة على Vapi" value={fmtNumber(totals.synced)} hint={`${totals.companies - totals.synced} غير منشورة`} accent="emerald" />
            <HeroStat label="جلسات الشات" value={fmtNumber(totals.chats)} hint="منذ بدء التشغيل" accent="sky" />
            <HeroStat label="المكالمات" value={fmtNumber(totals.calls)} hint="عبر Twilio + Vapi" accent="violet" />
          </div>
        )}

        {/* ─── Toolbar ─── */}
        <div className="flex items-center justify-between mb-4">
          <div className="text-[12px] text-ink-500 font-medium">
            {filtered ? `${filtered.length} ${filtered.length === 1 ? 'شركة' : 'شركة'}` : '...'}
          </div>
          <div className="flex items-center gap-1 text-[12px] text-ink-500 bg-white border border-ink-200 rounded-xl p-0.5">
            {[
              { id: 'recent',  label: 'الأحدث' },
              { id: 'busiest', label: 'الأكثر نشاطاً' },
              { id: 'name',    label: 'الاسم' },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setSort(opt.id)}
                className={cn(
                  'h-7 px-3 rounded-lg transition-colors',
                  sort === opt.id ? 'bg-ink-900 text-white' : 'hover:bg-ink-100 text-ink-700',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Grid ─── */}
        {!companies && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1,2,3].map((i) => <CompanyCardSkeleton key={i} />)}
          </div>
        )}
        {companies && filtered.length === 0 && (
          <EmptyState
            icon={search ? Building2 : Wand2}
            title={search ? 'ما فيه شركات تطابق البحث' : 'ابدأ بإنشاء أول شركة'}
            description={search
              ? `ما لقينا نتايج لـ "${search}". جرّب كلمة ثانية أو امسح البحث.`
              : 'أضف شركة، اكتب الـ system prompt وقاعدة المعرفة، وانشرها على Vapi لتبدأ بالعمل خلال دقايق.'}
            action={!search && (
              <Button variant="brand" onClick={() => { setEditing(null); setFormOpen(true); }} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" strokeWidth={2.5} /> شركة جديدة
              </Button>
            )}
          />
        )}
        {companies && filtered.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((c) => (
              <CompanyCard
                key={c.id}
                company={c}
                syncing={syncingId === c.id}
                binding={bindingId === c.id}
                onEdit={(c) => { setEditing(c); setFormOpen(true); }}
                onSync={onSync}
                onBindPhone={(c) => setBindOf(c)}
                onDelete={(c) => setDeleteOf(c)}
              />
            ))}
          </div>
        )}
      </div>

      <CompanyForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        onSave={onSave}
        initial={editing}
        saving={saving}
      />

      <ConfirmDialog
        open={!!deleteOf}
        onClose={() => setDeleteOf(null)}
        onConfirm={onDelete}
        confirmVariant="danger"
        confirmLabel="نعم، احذف"
        title={`حذف ${deleteOf?.name}؟`}
        message="هذه العملية ستحذف الشركة وكل جلسات الشات والمكالمات المرتبطة بها نهائياً. لا يمكن التراجع."
      />

      <ConfirmDialog
        open={!!bindOf}
        onClose={() => setBindOf(null)}
        onConfirm={onBindPhone}
        confirmLabel="نعم، اربط"
        title={`ربط الرقم بـ ${bindOf?.name}؟`}
        message="سيتم نقل الرقم +12182766062 إلى هذه الشركة، وفصله عن أي شركة أخرى. أي مكالمات قادمة هترد عليها هذه الشركة."
      />
    </div>
  );
}

function HeroStat({ label, value, hint, accent = 'brand' }) {
  const colors = {
    brand   : 'from-brand-50 to-white text-brand-700 ring-brand-200/60',
    emerald : 'from-emerald-50 to-white text-emerald-700 ring-emerald-200/60',
    sky     : 'from-sky-50 to-white text-sky-700 ring-sky-200/60',
    violet  : 'from-violet-50 to-white text-violet-700 ring-violet-200/60',
  }[accent];
  return (
    <div className="bg-white border border-ink-100 rounded-2xl p-4 shadow-card relative overflow-hidden">
      <div className={cn('absolute -top-10 -left-10 w-32 h-32 rounded-full bg-gradient-to-br opacity-50 blur-2xl', colors)} />
      <div className="relative">
        <div className="text-[11.5px] font-medium text-ink-500 uppercase tracking-wider">{label}</div>
        <div className="mt-2 text-[26px] font-bold text-ink-900 tabular-nums tracking-tight leading-none">{value}</div>
        <div className="mt-1.5 text-[11.5px] text-ink-500 flex items-center gap-1">
          {hint}
        </div>
      </div>
    </div>
  );
}
