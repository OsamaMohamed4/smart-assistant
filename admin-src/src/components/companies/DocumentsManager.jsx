import { useEffect, useRef, useState } from 'react';
import { Upload, FileText, Trash2, Sparkles, X, Loader2, Download, RefreshCw } from 'lucide-react';
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
  const replaceInputRef = useRef(null);
  const replaceDocRef   = useRef(null);

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
    if (!confirm(`حذف ${doc.filename}؟ ستُمسح كل المقاطع المرتبطة به.`)) return;
    try {
      await api.deleteDocument(companyId, doc.id);
      push('تم الحذف', 'success');
      load();
    } catch (e) { push(e.message, 'error'); }
  };

  // Replace: upload new file first, then delete the old one
  const onReplace = (doc) => {
    if (!confirm(`هل أنت متأكد من استبدال ${doc.filename}؟ سيتم حذف الملف القديم ورفع ملف جديد.`)) return;
    replaceDocRef.current = doc;
    replaceInputRef.current.value = '';
    replaceInputRef.current.click();
  };

  const handleReplaceFile = async (e) => {
    const file = e.target.files?.[0];
    const oldDoc = replaceDocRef.current;
    if (!file || !oldDoc) return;

    if (file.size > MAX_MB * 1024 * 1024) {
      push(`${file.name}: الحجم تجاوز ${MAX_MB}MB`, 'error');
      return;
    }

    setUploading(true);
    try {
      // Upload the new file first
      const r = await api.uploadDocument(companyId, file);
      push(`تم استبدال ${oldDoc.filename} → ${file.name} (${fmtNumber(r.chunkCount)} مقطع)`, 'success');
      // Then delete the old one
      await api.deleteDocument(companyId, oldDoc.id).catch(() => {});
      load();
    } catch (err) {
      push(`${file.name}: ${err.message}`, 'error');
    } finally {
      setUploading(false);
      replaceDocRef.current = null;
    }
  };

  const onDownload = (doc) => {
    // Open download URL in a new tab (uses the server's download endpoint)
    window.open(`/api/companies/${companyId}/documents/${doc.id}/download`, '_blank');
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
              {uploading ? 'جارٍ المعالجة...' : 'اسحب ملفاً أو اضغط للاختيار'}
            </div>
            <div className="text-[11.5px] text-ink-500 mt-0.5">
              PDF · DOCX · TXT · MD — حتى {MAX_MB}MB لكل ملف
            </div>
          </div>
        </div>
      </div>

      {/* Hidden input for replace flow (separate from main upload) */}
      <input
        ref={replaceInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={handleReplaceFile}
      />

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
          لا توجد مستندات. ارفع ملفاً ليبدأ المساعد بالاستفادة منه.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="border-b border-ink-100 text-[12px] text-ink-500 font-semibold">
                <th className="py-3 px-4 whitespace-nowrap">اسم الملف</th>
                <th className="py-3 px-4 whitespace-nowrap">تاريخ الرفع</th>
                <th className="py-3 px-4 whitespace-nowrap">آخر تعديل</th>
                <th className="py-3 px-4 whitespace-nowrap">الحجم</th>
                <th className="py-3 px-4 whitespace-nowrap text-left">الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <DocRow 
                  key={d.id} 
                  doc={d} 
                  onDelete={() => onDelete(d)} 
                  onReplace={() => onReplace(d)}
                  onDownload={() => onDownload(d)}
                />
              ))}
            </tbody>
          </table>
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

function DocRow({ doc, onDelete, onReplace, onDownload }) {
  const sizeMB = (doc.size_bytes / (1024 * 1024)).toFixed(1);
  const uploadDate = new Date(doc.created_at).toLocaleDateString('en-GB'); // DD/MM/YYYY
  const modifiedDate = uploadDate; // DB only tracks created_at for kb_documents right now

  return (
    <tr className="border-b border-ink-50 hover:bg-ink-50/30 transition-colors">
      <td className="py-3 px-4">
        <div className="text-[13.5px] font-medium text-ink-900 truncate" dir="auto">
          {doc.filename}
        </div>
      </td>
      <td className="py-3 px-4 text-[13px] text-ink-600 font-mono whitespace-nowrap">
        {uploadDate}
      </td>
      <td className="py-3 px-4 text-[13px] text-ink-600 font-mono whitespace-nowrap">
        {modifiedDate}
      </td>
      <td className="py-3 px-4 text-[13px] text-ink-600 font-mono whitespace-nowrap">
        {sizeMB} MB
      </td>
      <td className="py-3 px-4 text-left whitespace-nowrap">
        <div className="flex items-center justify-end gap-2 text-[12.5px] text-ink-500">
          <button onClick={onDownload} className="hover:text-brand-600 transition-colors">تنزيل</button>
          <span className="text-ink-200">-</span>
          <button onClick={onReplace} className="hover:text-brand-600 transition-colors">استبدال</button>
          <span className="text-ink-200">-</span>
          <button onClick={onDelete} className="hover:text-rose-600 transition-colors">حذف</button>
        </div>
      </td>
    </tr>
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
    <Modal open={open} onClose={onClose} size="lg" title="اختبار البحث" description={`اكتب سؤالاً وستظهر المقاطع التي يستخدمها مساعد ${companyName}.`}>
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
            اكتب سؤالاً لعرض المقاطع التي ستُدرج في الـ system prompt.
          </div>
        )}
        {result?.error && (
          <div className="bg-rose-50 text-rose-700 rounded-xl p-3 text-[13px]">{result.error}</div>
        )}
        {result?.chunks && (
          <div className="space-y-2.5">
            {result.chunks.length === 0 && (
              <div className="text-center py-6 text-[12.5px] text-ink-500">لا توجد مقاطع مطابقة.</div>
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
