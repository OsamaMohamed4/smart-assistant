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
  // KB metadata applied to files uploaded now (step 1: categories/tags).
  const [category, setCategory]   = useState('');
  const [tags, setTags]           = useState('');
  // Versioning (step 2): which document's version history is open.
  const [versionsFor, setVersionsFor] = useState(null);

  // ── Bulk-selection state ──
  const [selected, setSelected]   = useState(() => new Set()); // doc ids
  const [search, setSearch]       = useState('');
  const [confirm, setConfirm]     = useState({ open: false, mode: null, count: 0 }); // mode: 'selected' | 'all'
  const [deleting, setDeleting]   = useState(false);

  const inputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const replaceDocRef   = useRef(null);
  const newVersionInputRef = useRef(null);
  const newVersionDocRef   = useRef(null);

  const load = async () => {
    try { setDocs(await api.listDocuments(companyId, audience)); }
    catch (e) { push(e.message, 'error'); }
  };
  useEffect(() => { load(); }, [companyId, audience]);

  // Reset selection + search whenever the underlying list identity changes.
  useEffect(() => { setSelected(new Set()); setSearch(''); }, [companyId, audience]);

  // ── Derived: filtered rows + selection summary ──
  const q = search.trim().toLowerCase();
  // Only the active version of each document is listed; retired versions live in
  // the version-history modal. (is_active === 0 means retired; null = legacy = active.)
  const activeDocs = (docs || []).filter((d) => d.is_active !== 0);
  const filtered = activeDocs.filter(
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
        const r = await api.uploadDocument(companyId, file, audience, { category: category.trim(), tags: tags.trim() });
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
      const r = await api.uploadDocument(companyId, file, audience, { category: category.trim(), tags: tags.trim() });
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

  // Upload a file as a NEW VERSION of an existing document: it joins that
  // document's version group and becomes the active (searched) one; the previous
  // version is retired but kept in the version history.
  const onNewVersion = (doc) => {
    newVersionDocRef.current = doc;
    newVersionInputRef.current.value = '';
    newVersionInputRef.current.click();
  };
  const handleNewVersionFile = async (e) => {
    const file = e.target.files?.[0];
    const baseDoc = newVersionDocRef.current;
    if (!file || !baseDoc) return;
    if (file.size > MAX_MB * 1024 * 1024) { push(`${file.name}: الحجم تجاوز ${MAX_MB}MB`, 'error'); return; }
    setUploading(true);
    try {
      const r = await api.uploadDocument(companyId, file, audience, { category: category.trim(), tags: tags.trim(), versionOf: baseDoc.id });
      push(`تم نشر إصدار جديد (v${fmtNumber(r.version || '')}) لـ${baseDoc.filename} — أصبح هو النشط`, 'success');
      load();
    } catch (err) {
      push(`${file.name}: ${err.message}`, 'error');
    } finally {
      setUploading(false);
      newVersionDocRef.current = null;
    }
  };

  // Optional approval: move a document between 'published' (searchable) and
  // 'draft' (held out of search for review).
  const onSetStatus = async (doc, status) => {
    try {
      await api.setDocumentStatus(companyId, doc.id, status);
      push(status === 'draft'
        ? `${doc.filename}: حُوّل إلى مسودّة — خارج البحث حتى الاعتماد`
        : `${doc.filename}: اعتُمد ونُشر — أصبح داخل البحث`, 'success');
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
      {/* ─── KB metadata for the next upload (category + tags) ─── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="التصنيف (مثل: أسعار، مشاريع، سياسات)"
          className="h-8 w-44 sm:w-56 px-3 bg-white border border-ink-200 rounded-xl text-[12.5px] placeholder:text-ink-400 focus-ring focus:border-ink-300 font-arabic"
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="وسوم مفصولة بفواصل (اختياري)"
          className="h-8 w-44 sm:w-56 px-3 bg-white border border-ink-200 rounded-xl text-[12.5px] placeholder:text-ink-400 focus-ring focus:border-ink-300 font-arabic"
        />
        <span className="text-[11px] text-ink-400">تُطبَّق على الملفات التي ترفعها الآن</span>
      </div>

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

      {/* Hidden input for "new version" flow */}
      <input
        ref={newVersionInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={handleNewVersionFile}
      />

      {/* ─── Controls: stats · search · test · delete-all ─── */}
      {docs && activeDocs.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-ink-500 font-semibold uppercase tracking-wider">
            {fmtNumber(activeDocs.length)} مستند · {fmtNumber(activeDocs.reduce((s, d) => s + d.chunk_count, 0))} مقطع
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
      ) : activeDocs.length === 0 ? (
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
                  onNewVersion={() => onNewVersion(d)}
                  onVersions={() => setVersionsFor(d)}
                  onSetStatus={(status) => onSetStatus(d, status)}
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

      <VersionsModal
        doc={versionsFor}
        companyId={companyId}
        onClose={() => setVersionsFor(null)}
        onChanged={load}
      />
    </div>
  );
}

// Version history of one document: every version, which is active (searched) now,
// and a one-click revert to any earlier version.
function VersionsModal({ doc, companyId, onClose, onChanged }) {
  const { push } = useToast();
  const [versions, setVersions] = useState(null);
  const [busyId, setBusyId]     = useState(null);

  useEffect(() => {
    if (!doc) { setVersions(null); return; }
    let alive = true;
    (async () => {
      try { const v = await api.getDocumentVersions(companyId, doc.id); if (alive) setVersions(v); }
      catch (e) { if (alive) { push(e.message, 'error'); setVersions([]); } }
    })();
    return () => { alive = false; };
  }, [doc, companyId]);

  const activate = async (v) => {
    setBusyId(v.id);
    try {
      await api.activateDocumentVersion(companyId, v.id);
      push(`تم تفعيل الإصدار ${v.version} — أصبح هو النشط في البحث`, 'success');
      setVersions(await api.getDocumentVersions(companyId, doc.id));
      onChanged?.();
    } catch (e) {
      push(e.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal open={!!doc} onClose={onClose} size="md" title="سجل الإصدارات" description={doc ? doc.filename : ''}>
      {!versions ? (
        <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="shimmer h-12 rounded-xl" />)}</div>
      ) : versions.length === 0 ? (
        <div className="text-center py-6 text-[12.5px] text-ink-500">لا توجد إصدارات.</div>
      ) : (
        <div className="space-y-2">
          {versions.map((v) => (
            <div
              key={v.id}
              className={cn(
                'flex items-center justify-between gap-2 rounded-xl border p-3',
                v.is_active ? 'border-emerald-200 bg-emerald-50/60' : 'border-ink-100 bg-white',
              )}
            >
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-semibold text-ink-900">الإصدار {v.version}</span>
                {v.is_active
                  ? <Badge tone="success" dot>نشط (يُستخدم في البحث)</Badge>
                  : <span className="text-[11px] text-ink-400">سابق</span>}
                <span className="text-[11px] text-ink-400 font-mono">{fmtDateTime(v.created_at)} · {fmtNumber(v.chunk_count)} مقطع</span>
              </div>
              {!v.is_active && (
                <Button variant="secondary" size="sm" loading={busyId === v.id} onClick={() => activate(v)}>
                  استرجاع هذا الإصدار
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
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

// Real size: bytes / KB / MB so small files don't all read as "0.0 MB".
function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
// Date + time: DD/MM/YYYY HH:MM (24h).
function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function DocRow({ doc, selected, onToggle, onDelete, onReplace, onDownload, onNewVersion, onVersions, onSetStatus }) {
  const isDraft = doc.status === 'draft';
  const sizeLabel = fmtSize(doc.size_bytes);
  const uploadDate = fmtDateTime(doc.created_at);   // DD/MM/YYYY HH:MM
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
        <div className="text-[13.5px] font-medium text-ink-900 truncate flex items-center gap-1.5">
          <bdi>{doc.filename}</bdi>
          {doc.version > 1 && (
            <span className="text-[10.5px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5 shrink-0">
              الإصدار {doc.version}
            </span>
          )}
          {isDraft && (
            <span className="text-[10.5px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">
              مسودّة — خارج البحث
            </span>
          )}
        </div>
        {doc.metadata && (doc.metadata.category || (doc.metadata.tags && doc.metadata.tags.length > 0)) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {doc.metadata.category && (
              <span className="text-[10.5px] font-semibold text-brand-700 bg-brand-50 border border-brand-100 rounded px-1.5 py-0.5">
                {doc.metadata.category}
              </span>
            )}
            {(doc.metadata.tags || []).slice(0, 5).map((t, i) => (
              <span key={i} className="text-[10.5px] text-ink-500 bg-ink-50 border border-ink-100 rounded px-1.5 py-0.5">
                <bdi>{t}</bdi>
              </span>
            ))}
          </div>
        )}
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
        {sizeLabel}
      </td>
      <td className="py-3 px-4 text-left whitespace-nowrap">
        <div className="flex items-center justify-end gap-2 text-[12.5px] text-ink-500">
          {isDraft
            ? <button onClick={() => onSetStatus('published')} className="font-semibold text-emerald-600 hover:text-emerald-700 transition-colors">اعتماد ونشر</button>
            : <button onClick={() => onSetStatus('draft')} className="hover:text-amber-700 transition-colors">تحويل لمسودّة</button>}
          <span className="text-ink-200">-</span>
          <button onClick={onNewVersion} className="hover:text-brand-600 transition-colors">إصدار جديد</button>
          <span className="text-ink-200">-</span>
          <button onClick={onVersions} className="hover:text-brand-600 transition-colors">الإصدارات</button>
          <span className="text-ink-200">-</span>
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
