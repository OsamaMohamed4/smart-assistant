import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  MessageSquare, PhoneCall, RefreshCw, Mic, ArrowDownLeft, ArrowUpRight, Download,
  Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronDown,
  CheckCircle2, XCircle, Hourglass, Inbox,
} from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Avatar } from '../components/ui/Avatar';
import { EmptyState } from '../components/ui/EmptyState';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtDate, fmtDuration } from '../lib/utils';

// Sarj-style Conversations table. Every row is one chat session or one call,
// enriched with derived Status / Outcome / Direction columns the backend
// computes on the fly. Stays scoped to the workspace for client users via
// the pinnedCompanyId prop.
export function SessionsPage({ user, pinnedCompanyId }) {
  const { push } = useToast();
  const [filters, setFilters] = useState({
    period : 'all',
    type   : 'all',
    status : 'all',
    outcome: 'all',
    search : '',
  });
  const [page, setPage]     = useState(1);
  const [limit, setLimit]   = useState(10);
  const [data, setData]     = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected]     = useState(null);
  const [detail, setDetail]         = useState(null);

  const setFilter = (k) => (v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };

  // Server returns paginated data; we keep client logic minimal and rely on
  // the backend filter pipeline.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.conversations({
      ...filters,
      companyId: pinnedCompanyId,
      page,
      limit,
    })
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) push(e.message, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, page, limit, pinnedCompanyId, refreshKey]);

  const totalPages = Math.max(1, Math.ceil(data.total / limit));

  const onOpen = async (it) => {
    setSelected(it);
    try {
      if (it.type === 'chat') {
        const msgs = await api.getSession(it.sessionId);
        setDetail({ messages: msgs });
      } else {
        const call = await api.getCall(it.callId);
        setDetail(call);
      }
    } catch (e) {
      push(e.message, 'error');
      setSelected(null);
    }
  };

  const onResummarize = async () => {
    if (!selected) return;
    try {
      if (selected.type === 'chat') {
        const r = await api.summarizeSession(selected.sessionId);
        setDetail((d) => ({ ...d, summary: r.summary }));
      } else {
        const r = await api.summarizeCall(selected.callId);
        setDetail((d) => ({ ...d, summary: r.summary }));
      }
      push('تم توليد الملخص', 'success');
      setRefreshKey((k) => k + 1);
    } catch (e) { push(e.message, 'error'); }
  };

  // Download the *currently filtered* view as CSV. We page through the API in
  // chunks of 100 so a large filter still exports correctly without blowing
  // up memory on the server side.
  const exportCsv = useCallback(async () => {
    try {
      const all = [];
      let p = 1;
      const PAGE = 100;
      while (true) {
        const r = await api.conversations({ ...filters, companyId: pinnedCompanyId, page: p, limit: PAGE });
        all.push(...r.items);
        if (all.length >= r.total || r.items.length < PAGE) break;
        p += 1;
        if (p > 50) break; // hard ceiling: 5000 rows
      }
      const csv = toCsv(all);
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `conversations-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      push(`تم تصدير ${all.length} محادثة`, 'success');
    } catch (e) { push(e.message, 'error'); }
  }, [filters, pinnedCompanyId, push]);

  return (
    <div>
      <TopBar
        title="المحادثات"
        subtitle={loading
          ? 'جاري التحميل...'
          : `${data.total} ${data.total === 1 ? 'محادثة' : 'محادثة'} ${pinnedCompanyId ? '(workspace)' : ''}`}
        right={
          <Button variant="secondary" onClick={exportCsv} className="gap-1.5" disabled={loading || !data.total}>
            <Download className="w-3.5 h-3.5" strokeWidth={2} />
            تصدير
          </Button>
        }
      />

      <div className="px-8 py-6">
        {/* ─── Filter row ─── */}
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <SearchBox value={filters.search} onChange={setFilter('search')} placeholder="بحث برقم، إيميل، أو كلمة قيلت في المكالمة..." />
          <FilterSelect
            value={filters.status} onChange={setFilter('status')}
            options={[
              { v: 'all',         l: 'كل الحالات' },
              { v: 'completed',   l: 'مكتملة' },
              { v: 'in_progress', l: 'قيد التنفيذ' },
              { v: 'failed',      l: 'فاشلة' },
            ]}
          />
          <FilterSelect
            value={filters.outcome} onChange={setFilter('outcome')}
            options={[
              { v: 'all',           l: 'كل النتائج' },
              { v: 'success',       l: 'نجاح' },
              { v: 'not_available', l: 'غير متاحة' },
            ]}
          />
          <FilterSelect
            value={filters.period} onChange={setFilter('period')}
            options={[
              { v: 'all',     l: 'كل الفترات' },
              { v: 'today',   l: 'اليوم' },
              { v: 'week',    l: 'هذا الأسبوع' },
              { v: 'month',   l: 'هذا الشهر' },
              { v: 'quarter', l: 'هذا الربع' },
            ]}
          />
          <FilterSelect
            value={filters.type} onChange={setFilter('type')}
            options={[
              { v: 'all',   l: 'كل الأنواع' },
              { v: 'chat',  l: 'شات' },
              { v: 'voice', l: 'صوت' },
            ]}
          />
          <div className="flex-1" />
          <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} className="gap-1.5">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} strokeWidth={2} />
            تحديث
          </Button>
        </div>

        {/* ─── Table ─── */}
        <div className="bg-white border border-ink-100 rounded-2xl overflow-hidden shadow-card">
          {loading && !data.items.length ? (
            <div className="p-12 text-center text-ink-400 text-[13px]">جارٍ التحميل...</div>
          ) : data.items.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="لا توجد محادثات مطابقة"
              description="امسح الفلاتر أو غيّر الفترة الزمنية."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right" dir="rtl">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50/60 text-[11px] uppercase font-semibold text-ink-500 tracking-wider">
                    <Th>الوقت</Th>
                    <Th>المستخدم</Th>
                    <Th>النوع</Th>
                    <Th>الاتجاه</Th>
                    <Th>الرقم</Th>
                    <Th>السيناريو</Th>
                    <Th>الحالة</Th>
                    <Th>النتيجة</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.items.map((it) => (
                    <Row key={it.id} item={it} onOpen={onOpen} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ─── Pagination ─── */}
        {data.total > 0 && (
          <div className="mt-4 flex items-center justify-between text-[12.5px] text-ink-600">
            <div className="flex items-center gap-2">
              <span>عرض:</span>
              <select
                value={limit}
                onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
                className="h-8 px-2 pr-7 bg-white border border-ink-200 rounded-lg appearance-none focus-ring"
              >
                {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-ink-500">في كل صفحة</span>
              <span className="text-ink-400">·</span>
              <span className="tabular-nums">
                {((page - 1) * limit) + 1}–{Math.min(page * limit, data.total)} من {data.total}
              </span>
            </div>
            <PaginationControls
              page={page}
              totalPages={totalPages}
              onChange={(p) => setPage(p)}
            />
          </div>
        )}
      </div>

      <SessionDetail
        open={!!selected}
        onClose={() => { setSelected(null); setDetail(null); }}
        kind={selected?.type === 'voice' ? 'call' : 'chat'}
        data={detail}
        companyName={selected?.companyName}
        onResummarize={onResummarize}
      />
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────

function Th({ children }) {
  return <th className="px-4 py-3 text-right font-semibold whitespace-nowrap">{children}</th>;
}

function Row({ item, onOpen }) {
  return (
    <tr
      onClick={() => onOpen(item)}
      className="hover:bg-ink-50/50 cursor-pointer transition-colors"
    >
      <td className="px-4 py-3 text-[12.5px] text-ink-700 tabular-nums whitespace-nowrap">
        {fmtDate(item.timestamp)}
      </td>
      <td className="px-4 py-3 text-[12.5px] text-ink-700 truncate max-w-[180px]">
        {item.user || <span className="text-ink-400">—</span>}
      </td>
      <td className="px-4 py-3">
        <TypeBadge type={item.type} />
      </td>
      <td className="px-4 py-3">
        <DirectionBadge direction={item.direction} />
      </td>
      <td className="px-4 py-3 text-[12.5px] font-mono text-ink-700" dir="ltr">
        {item.phoneNumber || <span className="text-ink-400">—</span>}
      </td>
      <td className="px-4 py-3 max-w-[240px]">
        <ScenarioPill name={item.scenario} />
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={item.status} />
      </td>
      <td className="px-4 py-3">
        <OutcomeBadge outcome={item.outcome} />
      </td>
    </tr>
  );
}

function TypeBadge({ type }) {
  const isVoice = type === 'voice';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold',
      isVoice ? 'bg-violet-50 text-violet-700' : 'bg-brand-50 text-brand-700',
    )}>
      {isVoice ? <Mic className="w-2.5 h-2.5" /> : <MessageSquare className="w-2.5 h-2.5" />}
      {isVoice ? 'صوت' : 'شات'}
    </span>
  );
}

function DirectionBadge({ direction }) {
  const isOut = direction === 'outbound';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold',
      isOut ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700',
    )}>
      {isOut ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownLeft className="w-2.5 h-2.5" />}
      {isOut ? 'صادرة' : 'واردة'}
    </span>
  );
}

function StatusBadge({ status }) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="w-2.5 h-2.5" />
        مكتملة
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-50 text-amber-700">
        <Hourglass className="w-2.5 h-2.5" />
        قيد التنفيذ
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-rose-50 text-rose-700">
      <XCircle className="w-2.5 h-2.5" />
      فاشلة
    </span>
  );
}

function OutcomeBadge({ outcome }) {
  if (outcome === 'success') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="w-2.5 h-2.5" />
        نجاح
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-ink-100 text-ink-500">
      <Hourglass className="w-2.5 h-2.5" />
      غير متاحة
    </span>
  );
}

function ScenarioPill({ name }) {
  if (!name) return <span className="text-ink-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-50 text-sky-800 text-[11.5px] font-medium ring-1 ring-sky-200/60 max-w-full truncate">
      <span className="truncate">{name}</span>
    </span>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="relative w-[260px]">
      <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-400" strokeWidth={2} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-9 pr-9 pl-3 text-[13px] bg-white border border-ink-200 rounded-xl placeholder:text-ink-400 focus-ring focus:border-ink-300"
      />
    </div>
  );
}

function FilterSelect({ value, onChange, options }) {
  return (
    <div className="relative">
      <ChevronDown className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-400 pointer-events-none" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 pr-3 pl-7 text-[13px] bg-white border border-ink-200 rounded-xl appearance-none focus-ring focus:border-ink-300 font-arabic min-w-[120px]"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>{o.l}</option>
        ))}
      </select>
    </div>
  );
}

function PaginationControls({ page, totalPages, onChange }) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(1)}
        disabled={page === 1}
        className="w-8 h-8 rounded-lg border border-ink-200 bg-white text-ink-600 disabled:opacity-40 hover:bg-ink-50 transition-colors flex items-center justify-center"
      >
        <ChevronsRight className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page === 1}
        className="w-8 h-8 rounded-lg border border-ink-200 bg-white text-ink-600 disabled:opacity-40 hover:bg-ink-50 transition-colors flex items-center justify-center"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
      <span className="px-3 h-8 inline-flex items-center text-[12px] tabular-nums text-ink-600">
        {page} / {totalPages}
      </span>
      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
        className="w-8 h-8 rounded-lg border border-ink-200 bg-white text-ink-600 disabled:opacity-40 hover:bg-ink-50 transition-colors flex items-center justify-center"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => onChange(totalPages)}
        disabled={page === totalPages}
        className="w-8 h-8 rounded-lg border border-ink-200 bg-white text-ink-600 disabled:opacity-40 hover:bg-ink-50 transition-colors flex items-center justify-center"
      >
        <ChevronsLeft className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── CSV helpers ──────────────────────────────────────────────

function toCsv(rows) {
  const header = ['Time','User','Type','Direction','Phone','Scenario','Status','Outcome','Duration(s)','Messages','Summary'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.timestamp || '',
      r.user || '',
      r.type || '',
      r.direction || '',
      r.phoneNumber || '',
      r.scenario || '',
      r.status || '',
      r.outcome || '',
      r.duration ?? '',
      r.messages ?? '',
      r.summary || '',
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

function csvCell(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
