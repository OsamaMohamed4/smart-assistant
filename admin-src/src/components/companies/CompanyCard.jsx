import { Phone, Mic, Bot, BookOpen, MessageSquare, PhoneCall, MoreHorizontal, Rocket, Trash2, Pencil } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { cn, fmtNumber, relTime } from '../../lib/utils';
import { useState, useRef, useEffect } from 'react';

export function CompanyCard({ company, onEdit, onSync, onBindPhone, onDelete, syncing, binding }) {
  const c = company;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const synced     = !!c.assistantId;
  const hasPhone   = !!c.phoneNumber;
  const chatsCount = c.stats?.chats ?? 0;
  const callsCount = c.stats?.calls ?? 0;
  const lastAt     = c.stats?.lastActivity;

  return (
    <div className="group relative bg-white border border-ink-100 rounded-2xl shadow-card hover:shadow-pop hover:border-ink-200 transition-all duration-200 overflow-hidden">
      {/* ribbon if has phone */}
      {hasPhone && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-400 via-emerald-500 to-emerald-400" />
      )}

      <div className="p-5">
        <div className="flex items-start gap-4">
          <Avatar name={c.name} size={48} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-[15px] text-ink-900 leading-tight tracking-[-0.005em] truncate">{c.name}</h3>
                <div className="mt-1 flex items-center gap-2 text-[11.5px] font-mono text-ink-500">
                  <span>{c.id}</span>
                  {c.language && <span className="text-ink-300">·</span>}
                  {c.language && <span>{c.language}</span>}
                </div>
              </div>

              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="w-7 h-7 rounded-lg text-ink-400 hover:text-ink-700 hover:bg-ink-100 flex items-center justify-center transition-colors focus-ring"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
                {menuOpen && (
                  <div className="absolute left-0 top-9 w-44 bg-white border border-ink-100 rounded-xl shadow-pop py-1 z-10 animate-fade-in">
                    <button onClick={() => { setMenuOpen(false); onEdit(c); }} className="w-full px-3 py-2 text-right text-[13px] flex items-center gap-2.5 hover:bg-ink-50 text-ink-800">
                      <Pencil className="w-3.5 h-3.5 text-ink-500" strokeWidth={2} /> تعديل
                    </button>
                    <button onClick={() => { setMenuOpen(false); onBindPhone(c); }} className="w-full px-3 py-2 text-right text-[13px] flex items-center gap-2.5 hover:bg-ink-50 text-ink-800">
                      <Phone className="w-3.5 h-3.5 text-ink-500" strokeWidth={2} /> اربط الرقم
                    </button>
                    <div className="my-1 border-t border-ink-100" />
                    <button onClick={() => { setMenuOpen(false); onDelete(c); }} className="w-full px-3 py-2 text-right text-[13px] flex items-center gap-2.5 hover:bg-rose-50 text-rose-700">
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={2} /> حذف الشركة
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {synced
                ? <Badge tone="success" dot>منشور على Vapi</Badge>
                : <Badge tone="warning" dot>غير منشور</Badge>}
              {hasPhone && <Badge tone="brand" dot><Phone className="w-2.5 h-2.5 -mr-0.5" />{c.phoneNumber}</Badge>}
              {c.hasKB && <Badge tone="info"><BookOpen className="w-2.5 h-2.5 -mr-0.5" />KB</Badge>}
            </div>
          </div>
        </div>

        {/* ─── Stats row ─── */}
        <div className="mt-5 grid grid-cols-3 gap-2.5">
          <Stat icon={MessageSquare} label="شات" value={fmtNumber(chatsCount)} accent="brand" />
          <Stat icon={PhoneCall}    label="مكالمة" value={fmtNumber(callsCount)} accent="emerald" />
          <Stat icon={Mic}          label="آخر نشاط" value={lastAt ? relTime(lastAt) : '—'} accent="ink" small />
        </div>
      </div>

      <div className="px-5 py-3 border-t border-ink-100 bg-ink-50/40 flex items-center justify-between gap-2">
        <div className="text-[11.5px] text-ink-500 flex items-center gap-1.5 truncate">
          <Bot className="w-3 h-3 shrink-0" />
          <span className="truncate font-mono">
            {synced ? c.assistantId.slice(0, 8) + '…' : 'لم يُنشر بعد'}
          </span>
        </div>
        <Button variant="brand" size="sm" onClick={() => onSync(c)} loading={syncing} className="gap-1.5">
          <Rocket className="w-3 h-3" strokeWidth={2} />
          {synced ? 'تحديث' : 'نشر'}
        </Button>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, accent, small }) {
  const colors = {
    brand   : { ic: 'text-brand-500',   bg: 'bg-brand-50' },
    emerald : { ic: 'text-emerald-600', bg: 'bg-emerald-50' },
    ink     : { ic: 'text-ink-500',     bg: 'bg-ink-100/60' },
  }[accent] || { ic: 'text-ink-500', bg: 'bg-ink-100/60' };
  return (
    <div className="rounded-xl bg-ink-50/70 p-2.5 ring-1 ring-inset ring-ink-100/80">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-ink-500 uppercase tracking-wider">
        <div className={cn('w-4 h-4 rounded flex items-center justify-center', colors.bg)}>
          <Icon className={cn('w-2.5 h-2.5', colors.ic)} strokeWidth={2.5} />
        </div>
        {label}
      </div>
      <div className={cn('mt-1 font-semibold text-ink-900 tabular-nums tracking-tight', small ? 'text-[12px]' : 'text-[16px]')}>{value}</div>
    </div>
  );
}
