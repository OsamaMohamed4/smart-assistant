import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, PhoneCall, RefreshCw, Filter, Type, Mic, Inbox } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Avatar } from '../components/ui/Avatar';
import { RowSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, fmtDate, fmtDuration, relTime, fmtNumber } from '../lib/utils';

export function SessionsPage() {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [kind, setKind]           = useState('all');     // all | chat | call
  const [companyFilter, setCompanyFilter] = useState('');
  const [search, setSearch]       = useState('');
  const [items, setItems]         = useState(null);
  const [selected, setSelected]   = useState(null);
  const [detail, setDetail]       = useState(null);

  const loadCompanies = async () => {
    try { setCompanies(await api.listCompanies()); } catch (e) { push(e.message, 'error'); }
  };

  const load = async () => {
    setItems(null);
    try {
      const list = await api.listCompanies();
      const targets = companyFilter ? list.filter((c) => c.id === companyFilter) : list;
      const all = [];
      await Promise.all(targets.map(async (c) => {
        if (kind !== 'call') {
          const s = await api.listSessions(c.id, 100);
          s.forEach((row) => all.push({
            kind: 'chat', companyId: c.id, companyName: c.name,
            id: row.session_id, ts: row.last_at,
            messages: row.messages, summary: row.summary,
          }));
        }
        if (kind !== 'chat') {
          const cl = await api.listCalls(c.id, 100);
          cl.forEach((row) => all.push({
            kind: 'call', companyId: c.id, companyName: c.name,
            id: row.id, ts: row.created_at,
            caller: row.caller_number, duration: row.duration_sec,
            endedReason: row.ended_reason, summary: row.summary,
          }));
        }
      }));
      all.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      setItems(all);
    } catch (e) { push(e.message, 'error'); setItems([]); }
  };

  useEffect(() => { loadCompanies(); }, []);
  useEffect(() => { load(); }, [kind, companyFilter]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      (it.summary || '').toLowerCase().includes(q) ||
      (it.companyName || '').toLowerCase().includes(q) ||
      (it.id || '').toLowerCase().includes(q) ||
      (it.caller || '').toLowerCase().includes(q),
    );
  }, [items, search]);

  const stats = useMemo(() => {
    if (!items) return null;
    return {
      total: items.length,
      chats: items.filter((i) => i.kind === 'chat').length,
      calls: items.filter((i) => i.kind === 'call').length,
    };
  }, [items]);

  const onOpen = async (it) => {
    setSelected(it);
    try {
      if (it.kind === 'chat') {
        const msgs = await api.getSession(it.id);
        setDetail({ messages: msgs });
      } else {
        const call = await api.getCall(it.id);
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
      if (selected.kind === 'chat') {
        const r = await api.summarizeSession(selected.id);
        setDetail((d) => ({ ...d, summary: r.summary, messages: d.messages?.map((m) => ({ ...m, summary: r.summary })) }));
      } else {
        const r = await api.summarizeCall(selected.id);
        setDetail((d) => ({ ...d, summary: r.summary }));
      }
      push('تم توليد الملخص', 'success');
      load();
    } catch (e) { push(e.message, 'error'); }
  };

  return (
    <div>
      <TopBar
        title="السجلات"
        subtitle={stats ? `${fmtNumber(stats.total)} تفاعل (${fmtNumber(stats.chats)} شات + ${fmtNumber(stats.calls)} مكالمة)` : 'جاري التحميل...'}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="ابحث في الملخصات أو الجلسات..."
        right={
          <Button variant="secondary" onClick={load} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} /> تحديث
          </Button>
        }
      />

      <div className="px-8 py-7">
        {/* ─── Filters strip ─── */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex items-center gap-1 bg-white border border-ink-200 rounded-xl p-0.5">
            {[
              { id: 'all',  label: 'الكل',     icon: Inbox },
              { id: 'chat', label: 'الشات',    icon: MessageSquare },
              { id: 'call', label: 'المكالمات', icon: PhoneCall },
            ].map((t) => {
              const Icon = t.icon;
              const active = kind === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setKind(t.id)}
                  className={cn(
                    'h-8 px-3 rounded-lg text-[12.5px] font-medium flex items-center gap-1.5 transition-colors',
                    active ? 'bg-ink-900 text-white shadow-soft' : 'text-ink-600 hover:bg-ink-100',
                  )}
                >
                  <Icon className="w-3.5 h-3.5" strokeWidth={2} />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="relative">
            <Filter className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-400 pointer-events-none" />
            <select
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
              className="h-9 pr-9 pl-3 text-[13px] bg-white border border-ink-200 rounded-xl appearance-none focus-ring focus:border-ink-300 font-arabic"
            >
              <option value="">كل الشركات</option>
              {companies.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </select>
          </div>

          <div className="flex-1" />

          {stats && (
            <div className="text-[12px] text-ink-500">
              عرض <span className="font-semibold text-ink-700 tabular-nums">{filtered?.length || 0}</span> من <span className="tabular-nums">{stats.total}</span>
            </div>
          )}
        </div>

        {/* ─── List ─── */}
        {!items && (
          <div className="space-y-2">
            {[1,2,3,4].map((i) => <RowSkeleton key={i} />)}
          </div>
        )}
        {items && filtered.length === 0 && (
          <EmptyState
            icon={Inbox}
            title={search ? 'ما فيه نتايج للبحث' : 'ما فيه سجلات بعد'}
            description={search ? 'جرّب كلمة بحث ثانية أو نظّف الفلاتر' : 'لما يبدأ العملاء يكلموا المساعد، الجلسات هتظهر هنا تلقائياً مع ملخّصاتها الذكية.'}
          />
        )}
        {items && filtered.length > 0 && (
          <div className="bg-white border border-ink-100 rounded-2xl overflow-hidden shadow-card">
            <div className="grid grid-cols-[1fr_120px_140px_120px] gap-4 px-5 py-3 border-b border-ink-100 bg-ink-50/60 text-[11px] uppercase font-semibold text-ink-500 tracking-wider">
              <div>الجلسة</div>
              <div>الشركة</div>
              <div>التفاصيل</div>
              <div>الوقت</div>
            </div>
            <div className="divide-y divide-ink-100">
              {filtered.map((it) => (
                <SessionRow key={`${it.kind}-${it.id}`} item={it} onOpen={onOpen} />
              ))}
            </div>
          </div>
        )}
      </div>

      <SessionDetail
        open={!!selected}
        onClose={() => { setSelected(null); setDetail(null); }}
        kind={selected?.kind}
        data={detail}
        companyName={selected?.companyName}
        onResummarize={onResummarize}
      />
    </div>
  );
}

function SessionRow({ item, onOpen }) {
  const isCall = item.kind === 'call';
  return (
    <button
      onClick={() => onOpen(item)}
      className="w-full grid grid-cols-[1fr_120px_140px_120px] gap-4 px-5 py-4 text-right hover:bg-ink-50/40 transition-colors group items-center"
    >
      <div className="min-w-0 flex items-start gap-3">
        <div className={cn(
          'shrink-0 w-9 h-9 rounded-xl flex items-center justify-center',
          isCall ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60' : 'bg-brand-50 text-brand-700 ring-1 ring-brand-200/60'
        )}>
          {isCall ? <PhoneCall className="w-4 h-4" strokeWidth={2} /> : <MessageSquare className="w-4 h-4" strokeWidth={2} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[13.5px] font-semibold text-ink-900 truncate">
              {isCall ? `مكالمة من ${item.caller || 'مجهول'}` : `شات #${item.id.slice(0, 8)}`}
            </span>
            {!isCall && <Badge tone="neutral" className="text-[10px] !py-0">{item.messages} رسالة</Badge>}
          </div>
          <p className="text-[12.5px] text-ink-500 truncate leading-relaxed">
            {item.summary || (isCall ? '— لا يوجد ملخص بعد —' : '— اضغط لعرض التفاصيل وتوليد ملخص —')}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <Avatar name={item.companyName} size={24} />
        <span className="text-[12.5px] text-ink-700 truncate">{item.companyName}</span>
      </div>

      <div>
        {isCall ? (
          <div className="flex items-center gap-2 text-[12px] text-ink-600">
            <span className="tabular-nums">{fmtDuration(item.duration)}</span>
            <Badge tone={item.endedReason === 'customer-ended-call' ? 'success' : 'neutral'} dot>
              {item.endedReason ? item.endedReason.replace(/-/g,' ').slice(0, 12) : 'انتهت'}
            </Badge>
          </div>
        ) : (
          <Badge tone={item.summary ? 'success' : 'warning'} dot>
            {item.summary ? 'ملخّصة' : 'بدون ملخص'}
          </Badge>
        )}
      </div>

      <div className="text-[12px] text-ink-500 tabular-nums">
        {relTime(item.ts)}
      </div>
    </button>
  );
}
