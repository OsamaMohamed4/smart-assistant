import { Building2, MessageSquare, ChevronsLeft, LogOut, Users, LayoutDashboard, FileText, Sparkles, BookOpen, PhoneOutgoing, ShieldCheck, ClipboardList, Zap, Inbox } from 'lucide-react';
import { cn } from '../../lib/utils';
import { MasarMark } from '../ui/MasarMark';

// Two-tier nav: "Build" is where you author the assistant; "Monitor" is where
// you watch it run. Mirrors the structure of larger voice-agent dashboards
// so the demo reads as a proper SaaS product, not a single-page admin tool.
// `roles` restricts which user roles see the item — workspace clients only
// see their own data so platform-wide management lives behind superadmin.
const NAV_GROUPS = [
  {
    title: 'BUILD',
    items: [
      { id: 'scenarios',  label: 'السيناريوهات', icon: FileText,  hint: 'AI agents',         roles: ['superadmin', 'client'] },
      { id: 'knowledge',  label: 'قاعدة المعرفة', icon: BookOpen, hint: 'RAG',                roles: ['superadmin', 'client'] },
      // Company FACTS (hours, services, rules) — distinct from the Knowledge
      // Base, which holds documents. Both feed the prompt; this one is short,
      // structured and edited by hand.
      { id: 'profile',    label: 'بيانات الشركة', icon: ClipboardList, hint: 'حقائق',        roles: ['superadmin', 'client'] },
      // What the agent is ALLOWED to do. Distinct from the facts above: one is
      // what the agent knows, this is what it can act on.
      { id: 'capabilities', label: 'القدرات',   icon: Zap,      hint: 'أدوات',              roles: ['superadmin', 'client'] },
      { id: 'playground', label: 'التجربة',     icon: Sparkles,  hint: 'صوت + شات',          roles: ['superadmin', 'client'] },
      // 'companies' is visible to both superadmin and client. Inside a
      // workspace, the page renders only the client's own company.
      { id: 'companies',  label: 'الشركات',     icon: Building2, hint: 'إدارة',              roles: ['superadmin', 'client'] },
      { id: 'clients',    label: 'العملاء',     icon: Users,     hint: 'حسابات الزبائن',     roles: ['superadmin'] },
    ],
  },
  {
    title: 'MONITOR',
    items: [
      { id: 'dashboard',  label: 'لوحة التحكم', icon: LayoutDashboard, hint: 'تحليلات',             roles: ['superadmin', 'client'] },
      { id: 'sessions',   label: 'السجلات',     icon: MessageSquare,   hint: 'مكالمات + شات',       roles: ['superadmin', 'client'] },
      { id: 'requests',   label: 'الطلبات',     icon: Inbox,           hint: 'من الوكيل',           roles: ['superadmin', 'client'] },
      { id: 'campaigns',  label: 'الحملات',     icon: PhoneOutgoing,   hint: 'مكالمات صادرة',       roles: ['superadmin', 'client'] },
      { id: 'audit',      label: 'سجل العمليات', icon: ShieldCheck,    hint: 'audit',               roles: ['superadmin'] },
    ],
  },
];

function initials(label) {
  const s = (label || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || s[0].toUpperCase();
}

export function Sidebar({ active, onChange, user, onLogout, workspaceMode = false, mobileOpen = false, onClose }) {
  // Inside a workspace there's no "list of clients" page — that's a
  // control-plane concern. 'companies' is shown but the page itself filters
  // to a single company.
  const WORKSPACE_HIDDEN = new Set(['clients', 'audit']);
  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-[2px] lg:hidden" onClick={onClose} aria-hidden="true" />
      )}
    <aside className={cn(
      'bg-ink-950 text-ink-300 flex flex-col h-screen border-l border-ink-800/60 z-50',
      'fixed inset-y-0 right-0 w-[280px] max-w-[85vw] transition-transform duration-300 ease-out',
      mobileOpen ? 'translate-x-0' : 'translate-x-full',
      'lg:sticky lg:top-0 lg:inset-auto lg:z-30 lg:w-[260px] lg:shrink-0 lg:translate-x-0',
    )}>
      {/* ─── Brand ─── */}
      <div className="px-5 pt-6 pb-5 border-b border-white/[0.06] dot-grid">
        <div className="flex items-center gap-3">
          {/* The mark carries the brand on its own — no tile behind it. On the
              dark sidebar it is drawn in the lightest bronze tint, the only
              one of the brand's derived shades that stays legible there. */}
          <MasarMark className="h-7 shrink-0 text-[#C5A677]" title="مسار" />
          <div className="flex-1 min-w-0">
            <div className="text-white text-[14px] font-semibold leading-tight">مسار</div>
            <div className="text-ink-500 text-[11px] mt-0.5">لوحة التحكم</div>
          </div>
          <button onClick={onClose} aria-label="إغلاق القائمة" className="text-ink-500 hover:text-ink-300 w-7 h-7 rounded-md hover:bg-white/[0.06] flex items-center justify-center transition-colors">
            <ChevronsLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ─── Nav ─── */}
      <nav className="flex-1 px-3 py-4 space-y-4">
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((it) => {
            if (it.roles && !it.roles.includes(user?.role)) return false;
            if (workspaceMode && WORKSPACE_HIDDEN.has(it.id)) return false;
            return true;
          });
          if (!visible.length) return null;
          return (
            <div key={group.title} className="space-y-0.5">
              <div className="px-2 pb-2 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                {group.title}
              </div>
              {visible.map((item) => {
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
            </div>
          );
        })}
      </nav>

      {/* ─── Footer ─── */}
      <div className="p-3 border-t border-white/[0.06] space-y-0.5">
        {user && (
          <div>
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-white text-[12px] font-bold flex items-center justify-center shrink-0">
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
    </>
  );
}
