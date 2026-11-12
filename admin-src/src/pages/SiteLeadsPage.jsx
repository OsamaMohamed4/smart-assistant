import { useEffect, useState, useCallback } from 'react';
import {
  Inbox, RefreshCw, Download, Trash2, Mail, Phone, Building2, FileText,
  CheckCircle2, Archive, UserPlus, MessageSquare,
} from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtDate } from '../lib/utils';

// Leads from the public marketing site: "register interest" (contact) and job
// applications ("join"). Superadmin-only page — client accounts never reach it
// (the backend router rejects them, and the sidebar hides it).

const KIND = {
  contact: { label: 'تواصل', tone: 'bg-brand-50 text-brand-700', Icon: MessageSquare },
  join   : { label: 'توظيف', tone: 'bg-violet-50 text-violet-700', Icon: UserPlus },
};
const STATUS = {
  new     : { label: 'جديد',  tone: 'bg-emerald-50 text-emerald-700' },
  read    : { label: 'مقروء', tone: 'bg-ink-100 text-ink-600' },
  archived: { label: 'مؤرشف', tone: 'bg-amber-50 text-amber-800' },
};

const FILTERS = [
  { v: 'all',     l: 'الكل' },
  { v: 'contact', l: 'تواصل' },
  { v: 'join',    l: 'توظيف' },
];

export function SiteLeadsPage() {
  const { push } = useToast();
  const [kind, setKind]       = useState('all');
  const [page, setPage]       = useState(1);
  const [data, setData]       = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy]       = useState(false);
  const limit = 25;

  const load = useCallback(() => {
    setLoading(true);
    api.siteLeads({ kind: kind === 'all' ? undefined : kind, page, limit })
      .then(setData)
      .catch((e) => push(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [kind, page, push]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(data.total / limit));

  // Opening a lead marks it read (if it was new), so the list reflects it.
  const open = async (lead) => {
    setSelected(lead);
    if (lead.status === 'new') {
      try {
        await api.setSiteLeadStatus(lead.id, 'read');
        setSelected((s) => (s && s.id === lead.id ? { ...s, status: 'read' } : s));
        setData((d) => ({ ...d, items: d.items.map((x) => (x.id === lead.id ? { ...x, status: 'read' } : x)) }));
      } catch { /* non-fatal */ }
    }
  };

  const setStatus = async (lead, status) => {
    setBusy(true);
    try {
      await api.setSiteLeadStatus(lead.id, status);
      setSelected((s) => (s && s.id === lead.id ? { ...s, status } : s));
      setData((d) => ({ ...d, items: d.items.map((x) => (x.id === lead.id ? { ...x, status } : x)) }));
      push('تم تحديث الحالة', 'success');
    } catch (e) { push(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (lead) => {
    if (!window.confirm('حذف هذا الطلب نهائياً؟')) return;
    setBusy(true);
    try {
      await api.deleteSiteLead(lead.id);
      push('تم الحذف', 'success');
      setSelected(null);
      load();
    } catch (e) { push(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const downloadCv = (lead) => {
    window.open(api.siteLeadCvUrl(lead.id), '_blank', 'noopener');
  };

  return (
    <div>
      <TopBar
        title="طلبات الموقع"
        subtitle={loading ? 'جارٍ التحميل…' : `${data.total} طلب`}
        right={(
          <Button variant="secondary" onClick={load} className="gap-1.5">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} strokeWidth={2} />
            تحديث
          </Button>
        )}
      />

      <div className="px-8 py-6">
        {/* Filter */}
        <div className="flex items-center gap-2 mb-4">
          {FILTERS.map((f) => (
            <button
              key={f.v}
              onClick={() => { setKind(f.v); setPage(1); }}
              className={cn(
                'h-9 px-4 rounded-xl text-[13px] font-medium transition-colors border',
                kind === f.v ? 'bg-ink-900 text-white border-ink-900' : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50',
              )}
            >
              {f.l}
            </button>
          ))}
        </div>

        <Card className="overflow-hidden">
          {loading && !data.items.length ? (
            <div className="p-12 text-center text-ink-400 text-[13px]">جارٍ التحميل…</div>
          ) : !data.items.length ? (
            <EmptyState icon={Inbox} title="لا توجد طلبات" description="طلبات التواصل والتوظيف من الموقع تظهر هنا." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-[12.5px]" dir="rtl">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50/60 text-[11px] uppercase font-semibold text-ink-500 tracking-wider">
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">الوقت</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">النوع</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">الاسم</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">التواصل</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">الشركة / القطاع</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.items.map((it) => {
                    const k = KIND[it.kind] || KIND.contact;
                    const st = STATUS[it.status] || STATUS.new;
                    return (
                      <tr key={it.id} onClick={() => open(it)} className="hover:bg-ink-50/50 cursor-pointer transition-colors">
                        <td className="px-4 py-3 text-ink-600 tabular-nums whitespace-nowrap">{fmtDate(it.created_at)}</td>
                        <td className="px-4 py-3">
                          <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold', k.tone)}>
                            <k.Icon className="w-2.5 h-2.5" />{k.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-ink-900 font-medium">
                          {it.name || <span className="text-ink-400">—</span>}
                          {it.has_cv && <FileText className="inline-block w-3 h-3 text-ink-400 mr-1 align-middle" />}
                        </td>
                        <td className="px-4 py-3 text-ink-600" dir="ltr">
                          <div className="truncate max-w-[200px]">{it.email || it.phone || '—'}</div>
                        </td>
                        <td className="px-4 py-3 text-ink-600">
                          <div className="truncate max-w-[200px]">{[it.company, it.sector].filter(Boolean).join(' · ') || '—'}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn('inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold', st.tone)}>{st.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Pagination */}
        {data.total > limit && (
          <div className="mt-4 flex items-center justify-between text-[12.5px] text-ink-600">
            <span className="tabular-nums">
              {((page - 1) * limit) + 1}–{Math.min(page * limit, data.total)} من {data.total}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>السابق</Button>
              <span className="tabular-nums">{page} / {totalPages}</span>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>التالي</Button>
            </div>
          </div>
        )}
      </div>

      <LeadDetail
        lead={selected}
        busy={busy}
        onClose={() => setSelected(null)}
        onStatus={setStatus}
        onDelete={remove}
        onDownloadCv={downloadCv}
      />
    </div>
  );
}

function Field({ label, children, dir }) {
  if (!children) return null;
  return (
    <div>
      <div className="text-[11px] text-ink-500 mb-0.5">{label}</div>
      <div className="text-[13px] text-ink-900" dir={dir}>{children}</div>
    </div>
  );
}

function LeadDetail({ lead, busy, onClose, onStatus, onDelete, onDownloadCv }) {
  if (!lead) return null;
  const k = KIND[lead.kind] || KIND.contact;
  return (
    <Modal
      open={!!lead}
      onClose={onClose}
      title={lead.name || 'طلب'}
      description={`${k.label} · ${fmtDate(lead.created_at)}`}
      size="md"
      footer={(
        <>
          {lead.has_cv && (
            <Button variant="secondary" onClick={() => onDownloadCv(lead)} className="gap-1.5">
              <Download className="w-3.5 h-3.5" /> تحميل السيرة الذاتية
            </Button>
          )}
          {lead.status !== 'read' && (
            <Button variant="secondary" loading={busy} onClick={() => onStatus(lead, 'read')} className="gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> مقروء
            </Button>
          )}
          {lead.status !== 'archived' && (
            <Button variant="secondary" loading={busy} onClick={() => onStatus(lead, 'archived')} className="gap-1.5">
              <Archive className="w-3.5 h-3.5" /> أرشفة
            </Button>
          )}
          <Button variant="ghost" loading={busy} onClick={() => onDelete(lead)} className="gap-1.5 text-rose-600">
            <Trash2 className="w-3.5 h-3.5" /> حذف
          </Button>
        </>
      )}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="البريد الإلكتروني" dir="ltr">{lead.email}</Field>
        <Field label="رقم الجوال" dir="ltr">{lead.phone}</Field>
        <Field label="الشركة">{lead.company}</Field>
        <Field label="القطاع">{lead.sector}</Field>
        <Field label="متوسط المكالمات الشهرية">{lead.monthly_calls}</Field>
        {lead.has_cv && <Field label="السيرة الذاتية">{lead.cv_filename || 'مرفقة'}</Field>}
      </div>
      {lead.message && (
        <div className="mt-4">
          <div className="text-[11px] text-ink-500 mb-1">الرسالة</div>
          <div className="text-[13px] text-ink-800 leading-relaxed whitespace-pre-wrap rounded-xl bg-ink-50/70 border border-ink-100 px-4 py-3">
            {lead.message}
          </div>
        </div>
      )}
    </Modal>
  );
}
