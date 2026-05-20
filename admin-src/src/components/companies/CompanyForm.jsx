import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input, Textarea, Label } from '../ui/Input';
import { Button } from '../ui/Button';
import { Hash, Mic, Globe2, Sparkles, FileText, BookOpen, Settings2 } from 'lucide-react';
import { DocumentsManager } from './DocumentsManager';
import { cn } from '../../lib/utils';

const EMPTY = { id: '', name: '', language: 'ar-SA', voiceId: '', systemPrompt: '', kbText: '' };

const TABS = [
  { id: 'basics', label: 'الأساسيات',     icon: Settings2 },
  { id: 'kb',     label: 'النص السريع',   icon: BookOpen,  desc: 'Markdown يدمج في الـ prompt' },
  { id: 'rag',    label: 'ملفات الـ RAG', icon: FileText,  desc: 'PDF / DOCX / TXT — بحث ذكي' },
];

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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label hint="حروف صغيرة وأرقام فقط">المعرّف</Label>
              <Input
                name="id"
                value={data.id}
                onChange={update('id')}
                disabled={isEdit}
                required
                pattern="[a-z0-9-]+"
                placeholder="my-company"
                leftIcon={<Hash className="w-3.5 h-3.5" />}
              />
            </div>
            <div>
              <Label>اسم الشركة</Label>
              <Input
                value={data.name}
                onChange={update('name')}
                required
                placeholder="اسم شركتك بالكامل"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label hint="ar-SA, ar-EG, en-US...">اللغة</Label>
              <Input
                value={data.language}
                onChange={update('language')}
                placeholder="ar-SA"
                leftIcon={<Globe2 className="w-3.5 h-3.5" />}
              />
            </div>
            <div>
              <Label hint="ElevenLabs">معرّف الصوت</Label>
              <Input
                value={data.voiceId}
                onChange={update('voiceId')}
                placeholder="cFUFIbKkO2iZFwS8cRnY"
                leftIcon={<Mic className="w-3.5 h-3.5" />}
              />
            </div>
          </div>

          <div>
            <Label hint="تعليمات المساعد الأساسية">System Prompt</Label>
            <Textarea
              value={data.systemPrompt}
              onChange={update('systemPrompt')}
              required
              rows={8}
              placeholder={"اكتب هنا تفاصيل شركتك فقط — مش لازم تكرّر قواعد اللهجة أو الأسلوب، النظام يضيفها تلقائياً.\n\nمثال:\nأنت مساعد شركة [اسم الشركة] المتخصصة في [نوع النشاط].\nمهمتك: الرد على استفسارات العملاء عن [المنتجات/الخدمات/الأسعار/المواعيد]."}
            />
          </div>
        </form>
      )}

      {/* ─── Tab: KB (Markdown inline) ─── */}
      {tab === 'kb' && (
        <div>
          <Label hint="Markdown — يُدمج كامل في الـ system prompt مع كل سؤال">قاعدة المعرفة السريعة</Label>
          <Textarea
            value={data.kbText}
            onChange={update('kbText')}
            rows={18}
            placeholder={"# المنتجات أو الخدمات\n- عنصر أول: السعر بالريال\n- عنصر ثاني: السعر بالريال\n\n# المواعيد\n- من السبت إلى الخميس، من الساعة كذا إلى كذا.\n\n# سياسات\n- الإلغاء: ...\n- الاسترداد: ..."}
            className="font-mono text-[12.5px]"
          />
          <div className="mt-3 rounded-xl bg-amber-50/60 border border-amber-200/60 p-3 text-[12px] text-amber-900 leading-relaxed">
            <strong>متى تستخدمها:</strong> للمحتوى الصغير الثابت (أسعار قليلة، سياسات قصيرة). كل النص بيتبعت مع كل سؤال للموديل.<br/>
            <strong>للمحتوى الكبير</strong> (كتالوج طويل، مستندات PDF)، استخدم تبويب "ملفات الـ RAG" — هيبعت الأجزاء ذات الصلة فقط.
          </div>
        </div>
      )}

      {/* ─── Tab: RAG (file upload) ─── */}
      {tab === 'rag' && isEdit && (
        <DocumentsManager companyId={initial.id} companyName={initial.name} />
      )}
    </Modal>
  );
}
