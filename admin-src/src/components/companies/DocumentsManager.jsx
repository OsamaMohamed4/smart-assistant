import { useEffect, useRef, useState } from 'react';
import { Upload, FileText, Trash2, Sparkles, X, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { api } from '../../lib/api';
import { useToast } from '../ui/Toast';
import { cn, fmtNumber } from '../../lib/utils';

const ACCEPT = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';
const MAX_MB = 10;

export function DocumentsManager({ companyId, companyName }) {
  const { push } = useToast();
  const [docs, setDocs]         = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const [testOpen, setTestOpen]   = useState(false);
  const inputRef = useRef(null);

  const load = async () => {
    try { setDocs(await api.listDocuments(companyId)); }
    catch (e) { push(e.message, 'error'); }
  };
  useEffect(() => { load(); }, [companyId]);

  const handleFiles = async (files) => {
    const list = Array.from(files || []);
    for (const file of list) {
      if (file.size > MAX_MB * 1024 * 1024) {
        push(`${file.name}: الحجم تجاوز ${MAX_MB}MB`, 'error');
        continue;
      }
      setUploading(true);
      try {
        const r = await api.uploadDocument(companyId, file);
        push(`${file.name}: ${fmtNumber(r.chunkCount)} مقطع`, 'success');
      } catch (e) {
        push(`${file.name}: ${e.message}`, 'error');
      } finally {
        setUploading(false);
      }
    }
    load();
  };

  const onDelete = async (doc) => {
    if (!confirm(`حذف ${doc.filename}؟ كل الـ chunks بتاعته هتتمسح.`)) return;
    try {
      await api.deleteDocument(companyId, doc.id);
      push('تم الحذف', 'success');
      load();
    } catch (e) { push(e.message, 'error'); }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="space-y-3">
      {/* ─── Upload zone ─── */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-150 p-6 text-center',
          dragOver
            ? 'border-brand-400 bg-brand-50/60'
            : 'border-ink-200 bg-ink-50/40 hover:border-ink-300 hover:bg-ink-50',
          uploading && 'pointer-events-none opacity-70',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="flex flex-col items-center gap-2">
          <div className={cn(
            'w-11 h-11 rounded-xl flex items-center justify-center transition-colors',
            dragOver ? 'bg-brand-500 text-white' : 'bg-white border border-ink-200 text-ink-500',
          )}>
            {uploading
              ? <Loader2 className="w-4.5 h-4.5 animate-spin" />
              : <Upload className="w-4.5 h-4.5" strokeWidth={1.8} />}
          </div>
          <div>
            <div className="text-[13.5px] font-semibold text-ink-900">
              {uploading ? 'جاري الرفع والمعالجة...' : 'اسحب ملف أو اضغط لاختياره'}
            </div>
            <div className="text-[11.5px] text-ink-500 mt-0.5">
              PDF · DOCX · TXT · MD — حد أقصى {MAX_MB}MB لكل ملف
            </div>
          </div>
        </div>
      </div>

      {/* ─── Test button ─── */}
      {docs && docs.length > 0 && (
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-ink-500 font-semibold uppercase tracking-wider">
            {docs.length} مستند · {docs.reduce((s, d) => s + d.chunk_count, 0)} مقطع
          </div>
          <Button variant="secondary" size="sm" onClick={() => setTestOpen(true)} className="gap-1.5">
            <Sparkles className="w-3 h-3" strokeWidth={2} />
            اختبار البحث
          </Button>
        </div>
      )}

      {/* ─── Documents list ─── */}
      {!docs ? (
        <div className="space-y-2">
          {[1,2].map((i) => <div key={i} className="shimmer h-14 rounded-xl" />)}
        </div>
      ) : docs.length === 0 ? (
        <div className="text-center py-4 text-[12.5px] text-ink-500">
          ما فيه مستندات لسه — ارفع ملف عشان يبدأ المساعد يجاوب منه
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <DocRow key={d.id} doc={d} onDelete={() => onDelete(d)} />
          ))}
        </div>
      )}

      <RAGTestModal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        companyId={companyId}
        companyName={companyName}
      />
    </div>
  );
}

function DocRow({ doc, onDelete }) {
  const ext = (doc.filename.split('.').pop() || '').toLowerCase();
  const colorMap = {
    pdf : 'bg-rose-50 text-rose-600 ring-rose-200/60',
    docx: 'bg-sky-50 text-sky-600 ring-sky-200/60',
    txt : 'bg-ink-100 text-ink-600 ring-ink-200/60',
    md  : 'bg-brand-50 text-brand-600 ring-brand-200/60',
  };
  const color = colorMap[ext] || colorMap.txt;
  const sizeKB = (doc.size_bytes / 1024).toFixed(0);

  return (
    <div className="bg-white border border-ink-100 rounded-xl p-3 flex items-center gap-3 group hover:border-ink-200 transition-colors">
      <div className={cn('w-9 h-9 rounded-lg ring-1 ring-inset flex items-center justify-center shrink-0', color)}>
        <FileText className="w-4 h-4" strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium text-ink-900 truncate">{doc.filename}</div>
        <div className="text-[11.5px] text-ink-500 mt-0.5 flex items-center gap-2">
          <Badge tone="neutral" className="!py-0">{doc.chunk_count} مقطع</Badge>
          <span>·</span>
          <span>{sizeKB} KB</span>
          <span>·</span>
          <span className="uppercase">{ext}</span>
        </div>
      </div>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 w-8 h-8 rounded-lg text-ink-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition-all"
      >
        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.8} />
      </button>
    </div>
  );
}

function RAGTestModal({ open, onClose, companyId, companyName }) {
  const [query, setQuery]   = useState('');
  const [busy, setBusy]     = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery(''); setResult(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const run = async (e) => {
    e?.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true); setResult(null);
    try {
      const r = await api.ragTest(companyId, query.trim());
      setResult(r);
    } catch (e) {
      setResult({ error: e.message });
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="اختبار البحث في قاعدة المعرفة" description={`جرّب سؤال على ${companyName} وشوف أي مقاطع المساعد سيستخدمها`}>
      <form onSubmit={run} className="space-y-3">
        <div className="relative">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="مثلاً: كم سعر فندق برج العرب؟"
            className="w-full h-11 pr-4 pl-24 bg-white border border-ink-200 rounded-xl text-[14px] placeholder:text-ink-400 focus-ring focus:border-ink-400 font-arabic"
          />
          <Button type="submit" variant="brand" size="sm" loading={busy} className="absolute left-1.5 top-1.5 gap-1.5">
            <Sparkles className="w-3 h-3" />
            ابحث
          </Button>
        </div>
      </form>

      <div className="mt-5">
        {!result && !busy && (
          <div className="text-center py-8 text-[12.5px] text-ink-400">
            ادخل سؤال وشوف المقاطع اللي هتجي في الـ system prompt
          </div>
        )}
        {result?.error && (
          <div className="bg-rose-50 text-rose-700 rounded-xl p-3 text-[13px]">{result.error}</div>
        )}
        {result?.chunks && (
          <div className="space-y-2.5">
            {result.chunks.length === 0 && (
              <div className="text-center py-6 text-[12.5px] text-ink-500">ما فيه مقاطع تطابق هذا السؤال</div>
            )}
            {result.chunks.map((c, i) => {
              const tone = c.score >= 0.4 ? 'success' : c.score >= 0.25 ? 'warning' : 'neutral';
              return (
                <div key={c.id} className="bg-white border border-ink-100 rounded-xl p-3.5">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-ink-500 tabular-nums">#{i + 1}</span>
                      <Badge tone={tone} dot>صلة: {(c.score * 100).toFixed(0)}%</Badge>
                    </div>
                    <span className="text-[11px] font-mono text-ink-400">doc:{c.documentId} · chunk:{c.id}</span>
                  </div>
                  <p className="text-[13px] text-ink-800 leading-relaxed whitespace-pre-wrap font-arabic line-clamp-6">{c.text}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
