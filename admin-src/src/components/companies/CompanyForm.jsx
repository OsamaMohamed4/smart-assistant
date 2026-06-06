import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input, Label } from '../ui/Input';
import { Button } from '../ui/Button';
import { Sparkles } from 'lucide-react';

// systemPrompt/kbText are legacy fields — Scenarios fully replaced them.
// Kept in the EMPTY shape so the create payload stays compatible with the
// existing server route, but the form no longer surfaces inputs for them.
// RAG is now its own sidebar page (KnowledgeBasesPage), not a tab in here.
const EMPTY = { id: '', name: '', language: 'ar-SA', voiceId: '', systemPrompt: '', kbText: '' };

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
  const isEdit = !!initial;

  useEffect(() => {
    if (open) {
      setData(initial ? {
        id: initial.id, name: initial.name, language: initial.language || 'ar-SA',
        voiceId: initial.voiceId || '', systemPrompt: initial.systemPrompt || '', kbText: initial.kbText || '',
      } : EMPTY);
    }
  }, [open, initial]);

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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `تعديل ${initial.name}` : 'شركة جديدة'}
      description={isEdit ? 'حدّث البيانات ثم انشر التغييرات.' : 'أدخل اسم الشركة ثم انشرها بعد إنشاء سيناريو.'}
      size="md"
      footer={<>
        <Button variant="brand" onClick={submit} loading={saving}>
          <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
          {isEdit ? 'حفظ التغييرات' : 'إنشاء الشركة'}
        </Button>
        <Button variant="ghost" onClick={onClose}>إلغاء</Button>
      </>}
    >
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
          بعد الحفظ، أنشئ سيناريو من تبويب <strong>السيناريوهات</strong> وارفع الملفات من تبويب <strong>قاعدة المعرفة</strong>.
        </div>
      </form>
    </Modal>
  );
}
