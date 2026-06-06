import { useState, useEffect } from 'react';
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
  const isSuper = user.role === 'superadmin';
  const isWorkspace = !!pinnedCompanyId;

  // Workspace mode still hides the *list* of clients (that's a control-plane
  // concern), but the company-settings tab is visible — a workspace owner
  // needs to edit their own company details and republish to Vapi.
  const allowedTabs = isWorkspace
    ? new Set(['dashboard', 'scenarios', 'knowledge', 'playground', 'companies', 'sessions'])
    : isSuper
      ? new Set(['dashboard', 'scenarios', 'knowledge', 'playground', 'companies', 'clients', 'sessions'])
      : new Set(['dashboard', 'scenarios', 'knowledge', 'playground', 'sessions']);
  const activeTab = allowedTabs.has(tab) ? tab : 'dashboard';

  return (
    <div className="flex min-h-screen flex-row-reverse">
      <Sidebar
        active={activeTab}
        onChange={setTab}
        user={user}
        onLogout={onLogout}
        workspaceMode={isWorkspace}
      />
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
      </main>
    </div>
  );
}
