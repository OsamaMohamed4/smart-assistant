import { useState, useEffect } from 'react';
import { Sidebar } from './components/layout/Sidebar';
import { CompaniesPage } from './pages/CompaniesPage';
import { SessionsPage } from './pages/SessionsPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { CustomerPage } from './pages/CustomerPage';
import { AuthPage } from './pages/AuthPage';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ToastProvider } from './components/ui/Toast';
import { api, setUnauthenticatedHandler } from './lib/api';

function getRoute() {
  const m = window.location.pathname.match(/^\/c\/([a-z0-9-]+)/i);
  if (m) return { kind: 'customer', companyId: m[1] };
  return { kind: 'admin' };
}

export default function App() {
  const [route, setRoute] = useState(getRoute());
  // Default to the dashboard — it's the "front door" of the product and gives
  // a stronger first impression than the bare companies list.
  const [tab, setTab]     = useState('dashboard');
  const [user, setUser]   = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (route.kind !== 'admin') { setAuthChecked(true); return; }
    api.me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, [route.kind]);

  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null));
  }, []);

  if (route.kind === 'customer') {
    return (
      <ToastProvider>
        <CustomerPage companyId={route.companyId} />
      </ToastProvider>
    );
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50" dir="rtl">
        <div className="text-ink-400 text-sm">جارٍ التحميل…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <ToastProvider>
        <AuthPage onAuthed={setUser} />
      </ToastProvider>
    );
  }

  const onLogout = async () => {
    try { await api.logout(); } catch {}
    setUser(null);
  };

  // Tabs visible to the current role. Superadmin sees everything; a workspace
  // client (the business owner) only manages their own company so the
  // Companies and Clients tabs are hidden — they don't pick which company,
  // they ARE the company.
  const isSuper = user.role === 'superadmin';
  const allowedTabs = isSuper
    ? new Set(['dashboard', 'companies', 'clients', 'sessions', 'playground'])
    : new Set(['dashboard', 'sessions', 'playground']);
  const activeTab = allowedTabs.has(tab) ? tab : 'dashboard';

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-row-reverse">
        <Sidebar active={activeTab} onChange={setTab} user={user} onLogout={onLogout} />
        <main className="flex-1 min-w-0">
          {activeTab === 'dashboard'  && <DashboardPage user={user} />}
          {activeTab === 'companies'  && isSuper && <CompaniesPage />}
          {activeTab === 'clients'    && isSuper && <ClientsPage />}
          {activeTab === 'sessions'   && <SessionsPage user={user} />}
          {activeTab === 'playground' && <PlaygroundPage user={user} />}
        </main>
      </div>
    </ToastProvider>
  );
}
