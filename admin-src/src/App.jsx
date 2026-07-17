import { useState, useEffect } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { CompaniesPage } from './pages/CompaniesPage';
import { SessionsPage } from './pages/SessionsPage';
import { ScenariosPage } from './pages/ScenariosPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { KnowledgeBasesPage } from './pages/KnowledgeBasesPage';
import { WorkspaceGate } from './pages/WorkspaceGate';
import { AuthPage } from './pages/AuthPage';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { AuditPage } from './pages/AuditPage';
import { ToastProvider } from './components/ui/Toast';
import { api, setUnauthenticatedHandler } from './lib/api';

// Two front doors share the same SPA:
//   /admin      → osama (superadmin) sees every company aggregated
//   /c/<id>     → that company's workspace owner sees their company only
// The /c/<id> URL is the "branded" workspace link we share with each client;
// it gates on login the same way /admin does, then renders the exact same
// dashboard + sessions + playground UI but pinned to the URL's companyId.
function getRoute() {
  const m = window.location.pathname.match(/^\/c\/([a-z0-9-]+)/i);
  if (m) return { kind: 'workspace', companyId: m[1].toLowerCase() };
  return { kind: 'admin' };
}

export default function App() {
  const [route, setRoute] = useState(getRoute());
  const [tab, setTab]     = useState('dashboard');
  const [user, setUser]   = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    api.me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null));
  }, []);

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50" dir="rtl">
        <div className="text-ink-400 text-sm">جارٍ التحميل…</div>
      </div>
    );
  }

  // /c/<id> — login form is branded to the company, and only that company's
  // client (or a superadmin) can land on the dashboard.
  if (route.kind === 'workspace') {
    return (
      <ToastProvider>
        <WorkspaceGate
          companyId={route.companyId}
          user={user}
          onAuthed={setUser}
          onLogout={async () => { try { await api.logout(); } catch {} setUser(null); }}
          render={({ pinnedCompanyId, onLogout }) => (
            <AdminShell
              user={user}
              tab={tab}
              setTab={setTab}
              onLogout={onLogout}
              pinnedCompanyId={pinnedCompanyId}
            />
          )}
        />
      </ToastProvider>
    );
  }

  // /admin — superadmin's home. Bootstrap signup is allowed when there's no
  // user yet (the very first install creates the platform owner).
  if (!user) {
    return (
      <ToastProvider>
        <AuthPage onAuthed={setUser} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <AdminShell
        user={user}
        tab={tab}
        setTab={setTab}
        onLogout={async () => { try { await api.logout(); } catch {} setUser(null); }}
        pinnedCompanyId={null}
      />
    </ToastProvider>
  );
}

// Shared layout used by both /admin and /c/<id>. `pinnedCompanyId` locks every
// page to a single company (workspace mode); when null, superadmin gets the
// platform-wide view with company switchers and management tabs.
function AdminShell({ user, tab, setTab, onLogout, pinnedCompanyId }) {
  const [navOpen, setNavOpen] = useState(false);
  const isSuper = user.role === 'superadmin';
  const isWorkspace = !!pinnedCompanyId;

  // Workspace mode still hides the *list* of clients (that's a control-plane
  // concern), but the company-settings tab is visible — a workspace owner
  // needs to edit their own company details and republish to Vapi.
  const allowedTabs = isWorkspace
    ? new Set(['dashboard', 'scenarios', 'knowledge', 'playground', 'companies', 'sessions', 'campaigns'])
    : isSuper
      ? new Set(['dashboard', 'scenarios', 'knowledge', 'playground', 'companies', 'clients', 'sessions', 'campaigns', 'audit'])
      : new Set(['dashboard', 'scenarios', 'knowledge', 'playground', 'sessions', 'campaigns']);
  const activeTab = allowedTabs.has(tab) ? tab : 'dashboard';

  return (
    <div className="flex min-h-screen flex-row-reverse">
      <Sidebar
        active={activeTab}
        onChange={(t) => { setTab(t); setNavOpen(false); }}
        user={user}
        onLogout={onLogout}
        workspaceMode={isWorkspace}
        mobileOpen={navOpen}
        onClose={() => setNavOpen(false)}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="lg:hidden sticky top-0 z-30 flex items-center gap-2 h-14 px-3 bg-ink-950 text-white border-b border-ink-800/60">
          <button onClick={() => setNavOpen(true)} aria-label="فتح القائمة" className="w-11 h-11 rounded-lg flex items-center justify-center text-ink-200 hover:bg-white/10 active:bg-white/[0.15] transition-colors">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-400 to-brand-700 flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 1 0 6 0V4a3 3 0 0 0-3-3Zm7 11v-2a1 1 0 1 0-2 0v2a5 5 0 0 1-10 0v-2a1 1 0 1 0-2 0v2a7 7 0 0 0 6 6.92V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 12Z" /></svg>
            </div>
            <span className="text-[14px] font-semibold truncate">Smart Assistant</span>
          </div>
        </header>
        <main className="flex-1 min-w-0">
        {activeTab === 'dashboard' && <DashboardPage user={user} pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'scenarios'  && <ScenariosPage user={user} pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'knowledge'  && <KnowledgeBasesPage pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'playground' && <PlaygroundPage pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'companies' && (isSuper || isWorkspace) && (
          <CompaniesPage pinnedCompanyId={pinnedCompanyId} user={user} />
        )}
        {activeTab === 'clients'   && isSuper && !isWorkspace && <ClientsPage />}
        {activeTab === 'sessions'  && <SessionsPage user={user} pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'campaigns' && <CampaignsPage user={user} pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'audit'     && isSuper && !isWorkspace && <AuditPage />}
        </main>
      </div>
    </div>
  );
}
