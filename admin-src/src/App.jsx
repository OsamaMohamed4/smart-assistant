import { useState, useEffect } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { CompaniesPage } from './pages/CompaniesPage';
import { SessionsPage } from './pages/SessionsPage';
import { ScenariosPage } from './pages/ScenariosPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { KnowledgeBasesPage } from './pages/KnowledgeBasesPage';
import { BusinessProfilePage } from './pages/BusinessProfilePage';
import { CapabilitiesPage } from './pages/CapabilitiesPage';
import { WorkspaceGate } from './pages/WorkspaceGate';
import { AuthPage } from './pages/AuthPage';
import { LoginPage } from './pages/LoginPage';
import { MasarMark } from './components/ui/MasarMark';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { AuditPage } from './pages/AuditPage';
import { ToastProvider } from './components/ui/Toast';
import { api, setUnauthenticatedHandler } from './lib/api';

// Three front doors share the same SPA:
//   /login      → the public way in, linked from the marketing site
//   /admin      → osama (superadmin) sees every company aggregated
//   /c/<id>     → that company's workspace owner sees their company only
//
// The /c/<id> URL is the "branded" workspace link we share with each client;
// it gates on login the same way /admin does, then renders the exact same
// dashboard + sessions + playground UI but pinned to the URL's companyId.
//
// /login exists because a visitor arriving from the public site has no way to
// know their company id, and /admin is not something to advertise. It signs
// them in and sends them to whichever of the two they belong to.
function getRoute() {
  const path = window.location.pathname;
  const m = path.match(/^\/c\/([a-z0-9-]+)/i);
  if (m) return { kind: 'workspace', companyId: m[1].toLowerCase() };
  if (/^\/login\/?$/i.test(path)) return { kind: 'login' };
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

  // /login — the public front door. Already-signed-in visitors are forwarded
  // rather than shown a form they do not need.
  if (route.kind === 'login') {
    if (user?.role === 'client' && user.companyId) {
      window.location.replace(`/c/${encodeURIComponent(user.companyId)}`);
      return null;
    }
    if (user?.role === 'superadmin') {
      window.location.replace('/admin/');
      return null;
    }
    return (
      <ToastProvider>
        <LoginPage />
      </ToastProvider>
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
  // needs to edit their own company details and republish their agent.
  // 'profile' (company facts) is visible everywhere the knowledge base is: it
  // is the company's own content, and a workspace owner edits their own.
  const allowedTabs = isWorkspace
    ? new Set(['dashboard', 'scenarios', 'knowledge', 'profile', 'capabilities', 'playground', 'companies', 'sessions', 'campaigns'])
    : isSuper
      ? new Set(['dashboard', 'scenarios', 'knowledge', 'profile', 'capabilities', 'playground', 'companies', 'clients', 'sessions', 'campaigns', 'audit'])
      : new Set(['dashboard', 'scenarios', 'knowledge', 'profile', 'capabilities', 'playground', 'sessions', 'campaigns']);
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
            <MasarMark className="h-5 shrink-0 text-[#C5A677]" title="مسار" />
            <span className="text-[14px] font-semibold truncate">مسار</span>
          </div>
        </header>
        <main className="flex-1 min-w-0">
        {activeTab === 'dashboard' && <DashboardPage user={user} pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'scenarios'  && <ScenariosPage user={user} pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'knowledge'  && <KnowledgeBasesPage pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'profile'    && <BusinessProfilePage pinnedCompanyId={pinnedCompanyId} />}
        {activeTab === 'capabilities' && <CapabilitiesPage pinnedCompanyId={pinnedCompanyId} />}
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
