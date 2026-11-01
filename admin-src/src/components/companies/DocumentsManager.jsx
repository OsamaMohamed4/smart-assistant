import { useEffect, useRef, useState } from 'react';
import { Upload, FileText, Trash2, Sparkles, X, Loader2, Download, RefreshCw, AlertTriangle, Search } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { api } from '../../lib/api';
import { useToast } from '../ui/Toast';
import { cn, fmtNumber } from '../../lib/utils';

const ACCEPT = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';
const MAX_MB = 10;

// Arabic-correct "N files" label (singular / dual / plural / large).
function filesLabel(n) {
  if (n === 1) return 'ملف واحد';
  if (n === 2) return 'ملفان';
  if (n >= 3 && n <= 10) return `${fmtNumber(n)} ملفات`;
  return `${fmtNumber(n)} ملفًا`;
}

// `audience`: which of the company's two knowledge bases this manages --
// 'inbound' (inbound calls and WhatsApp) or 'outbound'.
export function DocumentsManager({ companyId, companyName, audience }) {
  const { push } = useToast();
  const [docs, setDocs]           = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const [testOpen, setTestOpen]   = useState(false);

  // ── Bulk-selection state ──
  const [selected, setSelected]   = useState(() => new Set()); // doc ids
  const [search, setSearch]       = useState('');
  const [confirm, setConfirm]     = useState({ open: false, mode: null, count: 0 }); // mode: 'selected' | 'all'
  const [deleting, setDeleting]   = useState(false);

  const inputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const replaceDocRef   = useRef(null);

  const load = async () => {
    try { setDocs(await api.listDocuments(companyId, audience)); }
    catch (e) { push(e.message, 'error'); }
  };
  useEffect(() => { load(); }, [companyId, audience]);

  // Reset selection + search whenever the underlying list identity changes.
  useEffect(() => { setSelected(new Set()); setSearch(''); }, [companyId, audience]);

  // ── Derived: filtered rows + selection summary ──
  const q = search.trim().toLowerCase();
  const filtered = (docs || []).filter(
    (d) => !q || String(d.filename || '').toLowerCase().includes(q),
  );
  const visibleIds = filtered.map((d) => d.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));
  // Only count selections that still exist in the current list.
  const liveIds = new Set((docs || []).map((d) => d.id));
  const selectedCount = [...selected].filter((id) => liveIds.has(id)).length;

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const askDeleteSelected = () => {
    if (!selectedCount) return;
    setConfirm({ open: true, mode: 'selected', count: selectedCount });
  };
  const askDeleteAll = () => {
    if (!docs || !docs.length) return;
    setConfirm({ open: true, mode: 'all', count: docs.length });
  };
  const closeConfirm = () => { if (!deleting) setConfirm({ open: false, mode: null, count: 0 }); };

  const doDelete = async () => {
    setDeleting(true);
    try {
      const r = confirm.mode === 'all'
        ? await api.deleteAllDocuments(companyId, audience)
        : await api.bulkDeleteDocuments(companyId, [...selected].filter((id) => liveIds.has(id)), audience);

      const done = r?.deleted || 0;
      const failed = r?.failed || 0;
      if (done && failed) push(`حُذف ${filesLabel(done)}، وتعذّر حذف ${fmtNumber(failed)}.`, 'warning');
      else if (done)       push(`تم حذف ${filesLabel(done)}.`, 'success');
      else                 push('لم يُحذف أي ملف.', 'error');

      clearSelection();
      setConfirm({ open: false, mode: null, count: 0 });
      await load();
    } catch (e) {
      push(e.message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleFiles = async (files) => {
    const list = Array.from(files || []);
    for (const file of list) {
      if (file.size > MAX_MB * 1024 * 1024) {
        push(`${file.name}: الحجم تجاوز ${MAX_MB}MB`, 'error');
        continue;
      }
      setUploading(true);
      try {
        const r = await api.uploadDocument(companyId, file, audience);
        if (r.quality && r.quality.level !== 'ok') {
          // Big/empty extraction — warn instead of a plain success toast.
          push(`${file.name}: ${r.quality.message}`, r.quality.level === 'empty' ? 'error' : 'warning');
        } else {
          push(`${file.name}: ${fmtNumber(r.chunkCount)} مقطع`, 'success');
        }
      } catch (e) {
        push(`${file.name}: ${e.message}`, 'error');
      } finally {
        setUploading(false);
      }
    }
    load();
  };

  const onDelete = async (doc) => {
    if (!confirm.open && !window.confirm(`حذف ${doc.filename}؟ ستُمسح كل المقاطع المرتبطة به.`)) return;
    try {
      await api.deleteDocument(companyId, doc.id);
      push('تم الحذف', 'success');
      setSelected((prev) => { const n = new Set(prev); n.delete(doc.id); return n; });
      load();
    } catch (e) { push(e.message, 'error'); }
  };

  // Replace: upload new file first, then delete the old one
  const onReplace = (doc) => {
    if (!window.confirm(`هل أنت متأكد من استبدال ${doc.filename}؟ سيتم حذف الملف القديم ورفع ملف جديد.`)) return;
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
      // Upload the new file first, into the same knowledge base
      const r = await api.uploadDocument(companyId, file, audience);
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

      {/* ─── Controls: stats · search · test · delete-all ─── */}
      {docs && docs.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-ink-500 font-semibold uppercase tracking-wider">
            {fmtNumber(docs.length)} مستند · {fmtNumber(docs.reduce((s, d) => s + d.chunk_count, 0))} مقطع
            {q && <span className="normal-case tracking-normal font-medium text-ink-400"> · نتائج البحث: {fmtNumber(filtered.length)}</span>}
          </div>
          <div className="flex items-center gap-2">
            {/* Search / filter */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="بحث باسم الملف"
                className="h-8 w-40 sm:w-52 pr-8 pl-7 bg-white border border-ink-200 rounded-xl text-[12.5px] placeholder:text-ink-400 focus-ring focus:border-ink-300 font-arabic"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="مسح البحث"
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <Button variant="secondary" size="sm" onClick={() => setTestOpen(true)} className="gap-1.5">
              <Sparkles className="w-3 h-3" strokeWidth={2} />
              اختبار البحث
            </Button>
            <Button variant="danger" size="sm" onClick={askDeleteAll} className="gap-1.5">
              <Trash2 className="w-3 h-3" strokeWidth={2} />
              حذف الكل
            </Button>
          </div>
        </div>
      )}

      {/* ─── Selection toolbar ─── */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-200 bg-brand-50/70 px-3 py-2">
          <div className="text-[12.5px] text-ink-800">
            <span className="font-semibold">محدد: {filesLabel(selectedCount)}</span>
            {q && <span className="text-ink-500"> · ضمن نتائج البحث فقط</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="danger" size="sm" onClick={askDeleteSelected} className="gap-1.5">
              <Trash2 className="w-3 h-3" strokeWidth={2} />
              حذف المحدد
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection}>إلغاء التحديد</Button>
          </div>
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
      ) : filtered.length === 0 ? (
        <div className="text-center py-4 text-[12.5px] text-ink-500">
          لا توجد ملفات تطابق «{search}».
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="border-b border-ink-100 text-[12px] text-ink-500 font-semibold">
                <th className="py-3 px-4 w-10">
                  <HeaderCheckbox
                    checked={allVisibleSelected}
                    indeterminate={!allVisibleSelected && someVisibleSelected}
                    onChange={toggleAllVisible}
                    title={q ? 'تحديد كل نتائج البحث الظاهرة' : 'تحديد كل الملفات'}
                  />
                </th>
                <th className="py-3 px-4 whitespace-nowrap">اسم الملف</th>
                <th className="py-3 px-4 whitespace-nowrap">تاريخ الرفع</th>
                <th className="py-3 px-4 whitespace-nowrap">آخر تعديل</th>
                <th className="py-3 px-4 whitespace-nowrap">الحجم</th>
                <th className="py-3 px-4 whitespace-nowrap text-left">الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <DocRow
                  key={d.id}
                  doc={d}
                  selected={selected.has(d.id)}
                  onToggle={() => toggleOne(d.id)}
                  onDelete={() => onDelete(d)}
                  onReplace={() => onReplace(d)}
                  onDownload={() => onDownload(d)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Bulk-delete confirmation ─── */}
      <Modal
        open={confirm.open}
        onClose={closeConfirm}
        size="sm"
        title="تأكيد الحذف"
        footer={<>
          <Button variant="danger" loading={deleting} onClick={doDelete}>
            {deleting ? 'جارٍ الحذف…' : `حذف ${filesLabel(confirm.count)}`}
          </Button>
          <Button variant="ghost" disabled={deleting} onClick={closeConfirm}>إلغاء</Button>
        </>}
      >
        <p className="text-[13.5px] text-ink-700 leading-relaxed">
          {confirm.mode === 'all'
            ? `سيتم حذف جميع الملفات في هذا القسم (${filesLabel(confirm.count)}) نهائياً، مع كل المقاطع المفهرسة المرتبطة بها، فلا يعود المساعد الذكي يصل إلى محتواها. لا يمكن التراجع عن هذا الإجراء.`
            : `سيتم حذف ${filesLabel(confirm.count)} المحددة نهائياً، مع كل المقاطع المفهرسة المرتبطة بها، فلا يعود المساعد الذكي يصل إلى محتواها. لا يمكن التراجع عن هذا الإجراء.`}
        </p>
      </Modal>

      <RAGTestModal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        companyId={companyId}
        companyName={companyName}
        audience={audience}
      />
    </div>
  );
}

// Checkbox for the table header that also renders the "indeterminate" (some
// but not all selected) state the DOM only exposes via a ref.
function HeaderCheckbox({ checked, indeterminate, onChange, title }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      title={title}
      className="w-4 h-4 rounded border-ink-300 accent-brand-500 cursor-pointer align-middle"
    />
  );
}

function DocRow({ doc, selected, onToggle, onDelete, onReplace, onDownload }) {
  const sizeMB = (doc.size_bytes / (1024 * 1024)).toFixed(1);
  const uploadDate = new Date(doc.created_at).toLocaleDateString('en-GB'); // DD/MM/YYYY
  const modifiedDate = uploadDate; // DB only tracks created_at for kb_documents right now

  return (
    <tr className={cn(
      'border-b border-ink-50 transition-colors',
      selected ? 'bg-brand-50/50' : 'hover:bg-ink-50/30',
    )}>
      <td className="py-3 px-4 w-10">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`تحديد ${doc.filename}`}
          className="w-4 h-4 rounded border-ink-300 accent-brand-500 cursor-pointer align-middle"
        />
      </td>
      <td className="py-3 px-4">
        <div className="text-[13.5px] font-medium text-ink-900 truncate">
          <bdi>{doc.filename}</bdi>
        </div>
        {doc.quality && doc.quality.level !== 'ok' && (
          <div className={cn(
            'mt-1 inline-flex items-center gap-1 text-[11px] font-medium rounded-md px-1.5 py-0.5',
            doc.quality.level === 'empty' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800',
          )} title={doc.quality.message}>
            <AlertTriangle className="w-2.5 h-2.5" />
            {doc.quality.level === 'empty' ? 'لم يُستخرج نص' : 'نص قليل — غالباً صور'}
          </div>
        )}
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

function RAGTestModal({ open, onClose, companyId, companyName, audience }) {
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
      const r = await api.ragTest(companyId, query.trim(), audience);
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
            اكتب سؤالاً لتظهر المقاطع التي سيعتمد عليها المساعد في الرد.
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
