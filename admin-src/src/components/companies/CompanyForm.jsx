import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input, Label } from '../ui/Input';
import { Button } from '../ui/Button';
import { Sparkles, FileText, Settings2 } from 'lucide-react';
import { DocumentsManager } from './DocumentsManager';
import { cn } from '../../lib/utils';

// systemPrompt/kbText are legacy fields — Scenarios fully replaced them.
// Kept in the EMPTY shape so the create payload stays compatible with the
// existing server route, but the form no longer surfaces inputs for them.
const EMPTY = { id: '', name: '', language: 'ar-SA', voiceId: '', systemPrompt: '', kbText: '' };

const TABS = [
  { id: 'basics', label: 'الأساسيات',     icon: Settings2 },
  { id: 'rag',    label: 'قاعدة المعرفة (RAG)', icon: FileText,  desc: 'PDF / DOCX / TXT — بحث ذكي' },
];

// Slugify the company name into a URL-safe id. For mostly-English names we
// get something readable (e.g. "Wakan Real Estate" → "wakan-real-estate").
// Arabic-only names produce nothing usable through this path, so we fall
// back to a short random suffix that's still URL-safe.
function slugifyName(name) {
  const ascii = (name || '')
    .toLowerCase()
    .replace(/[ً-ْ]/g, '')        // tashkeel
    .replace(/[؀-ۿ\s]+/g, '-')    // Arabic block + whitespace → dash
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  if (ascii.length >= 2) return ascii;
  return 'co-' + Math.random().toString(36).slice(2, 8);
}

export function CompanyForm({ open, onClose, onSave, initial, saving }) {
  const [data, setData] = useState(EMPTY);
  const [tab, setTab]   = useState('basics');
  const isEdit = !!initial;

  useEffect(() => {
    if (open) {
      setData(initial ? {
        id: initial.id, name: initial.name, language: initial.language || 'ar-SA',
        voiceId: initial.voiceId || '', systemPrompt: initial.systemPrompt || '', kbText: initial.kbText || '',
      } : EMPTY);
      setTab('basics');
    }
  }, [open, initial]);

  const update = (k) => (e) => setData((d) => ({ ...d, [k]: e.target.value }));

  // Keep id auto-derived from name during creation. The user never sees the
  // field, but the URL slug (and Vapi assistant name) get something stable
  // and URL-safe out of the box.
  const updateName = (e) => {
    const name = e.target.value;
    setData((d) => ({ ...d, name, id: isEdit ? d.id : slugifyName(name) }));
  };

  const submit = async (e) => {
    e?.preventDefault();
    await onSave(data);
  };

  // RAG tab is only available for an existing company (needs companyId on every request).
  const tabsAvailable = isEdit ? TABS : TABS.filter((t) => t.id !== 'rag');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `تعديل ${initial.name}` : 'شركة جديدة'}
      description={isEdit ? 'حدّث البيانات وانشر التغييرات إلى Vapi بعدها' : 'املأ التفاصيل ثم انشر الشركة على Vapi ليبدأ المساعد بالعمل'}
      size="lg"
      footer={tab !== 'rag' ? <>
        <Button variant="brand" onClick={submit} loading={saving}>
          <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
          {isEdit ? 'حفظ التغييرات' : 'إنشاء الشركة'}
        </Button>
        <Button variant="ghost" onClick={onClose}>إلغاء</Button>
      </> : <Button variant="ghost" onClick={onClose}>إغلاق</Button>}
    >
      {/* ─── Tabs ─── */}
      <div className="flex items-center gap-1 bg-ink-50/80 border border-ink-100 rounded-2xl p-1 mb-5 w-fit">
        {tabsAvailable.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              type="button"
              className={cn(
                'h-9 px-3.5 rounded-xl flex items-center gap-2 text-[12.5px] font-medium transition-all',
                active
                  ? 'bg-white text-ink-900 shadow-soft ring-1 ring-ink-100'
                  : 'text-ink-600 hover:text-ink-900',
              )}
            >
              <Icon className={cn('w-3.5 h-3.5', active ? 'text-brand-500' : 'text-ink-500')} strokeWidth={2} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ─── Tab: Basics ─── */}
      {tab === 'basics' && (
        <form onSubmit={submit} className="space-y-5">
          <div>
            <Label>اسم الشركة</Label>
            <Input
              value={data.name}
              onChange={updateName}
              required
              placeholder="اسم شركتك بالكامل"
            />
            {!isEdit && data.id && (
              <p className="mt-1.5 text-[11px] text-ink-400 font-mono" dir="ltr">
                URL: /c/{data.id}
              </p>
            )}
          </div>


          <div className="rounded-xl bg-brand-50/60 border border-brand-200/60 p-3 text-[12px] text-brand-900 leading-relaxed">
            <strong>الـ Prompt والرسالة الافتتاحية</strong> اتنقلوا لتبويب <strong>السيناريوهات</strong>. أنشئ سيناريو وفعّله بعد ما تحفظ الشركة.
          </div>
        </form>
      )}

      {/* ─── Tab: RAG (file upload) ─── */}
      {tab === 'rag' && isEdit && (
        <DocumentsManager companyId={initial.id} companyName={initial.name} />
      )}
    </Modal>
  );
}
