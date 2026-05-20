import { Building2, MessageSquare, Sparkles, ChevronsLeft, LogOut, Users } from 'lucide-react';
import { cn } from '../../lib/utils';

const NAV = [
  { id: 'companies',  label: 'الشركات',  icon: Building2,     hint: 'إدارة' },
  { id: 'clients',    label: 'العملاء',  icon: Users,         hint: 'حسابات الزبائن' },
  { id: 'sessions',   label: 'السجلات',  icon: MessageSquare, hint: 'مكالمات + شات' },
  { id: 'playground', label: 'التجربة',  icon: Sparkles,      hint: 'دردشة حية' },
];

function initials(label) {
  const s = (label || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || s[0].toUpperCase();
}

export function Sidebar({ active, onChange, user, onLogout }) {
  return (
    <aside className="w-[260px] shrink-0 bg-ink-950 text-ink-300 flex flex-col h-screen sticky top-0 border-l border-ink-800/60">
      {/* ─── Brand ─── */}
      <div className="px-5 pt-6 pb-5 border-b border-white/[0.06] dot-grid">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 flex items-center justify-center shadow-[0_2px_8px_rgba(91,91,214,0.45)]">
            <svg viewBox="0 0 24 24" className="w-4.5 h-4.5 text-white" fill="currentColor">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 1 0 6 0V4a3 3 0 0 0-3-3Zm7 11v-2a1 1 0 1 0-2 0v2a5 5 0 0 1-10 0v-2a1 1 0 1 0-2 0v2a7 7 0 0 0 6 6.92V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 12Z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-white text-[14px] font-semibold leading-tight">Smart Assistant</div>
            <div className="text-ink-500 text-[11px] mt-0.5">لوحة التحكم</div>
          </div>
          <button className="text-ink-500 hover:text-ink-300 w-7 h-7 rounded-md hover:bg-white/[0.06] flex items-center justify-center transition-colors">
            <ChevronsLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ─── Nav ─── */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        <div className="px-2 pb-2 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">القوائم</div>
        {NAV.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={cn(
                'group w-full flex items-center gap-3 px-3 h-10 rounded-xl text-[13.5px] transition-all',
                isActive
                  ? 'bg-white/[0.08] text-white shadow-inner-1'
                  : 'text-ink-400 hover:bg-white/[0.04] hover:text-ink-200',
              )}
            >
              <Icon className={cn(
                'w-4 h-4 shrink-0',
                isActive ? 'text-brand-300' : 'text-ink-500 group-hover:text-ink-300',
              )} strokeWidth={1.8} />
              <span className="flex-1 text-right font-medium">{item.label}</span>
              <span className={cn(
                'text-[10.5px] px-1.5 py-0.5 rounded transition-colors',
                isActive ? 'bg-brand-500/15 text-brand-300' : 'text-ink-600 group-hover:text-ink-500'
              )}>{item.hint}</span>
            </button>
          );
        })}
      </nav>

      {/* ─── Footer ─── */}
      <div className="p-3 border-t border-white/[0.06] space-y-0.5">
        {user && (
          <div>
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-400 to-accent-violet text-white text-[12px] font-bold flex items-center justify-center shrink-0">
                {initials(user.name || user.email)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-ink-100 text-[12.5px] font-medium leading-tight truncate">
                  {user.name || user.email}
                </div>
                <div className="text-ink-500 text-[10.5px] mt-0.5 capitalize">{user.role}</div>
              </div>
              <button
                onClick={onLogout}
                title="تسجيل الخروج"
                className="w-7 h-7 rounded-md text-ink-400 hover:text-rose-300 hover:bg-rose-500/10 flex items-center justify-center transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
