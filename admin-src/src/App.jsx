import { useState, useEffect } from 'react';
import { Sidebar } from './components/layout/Sidebar';
import { CompaniesPage } from './pages/CompaniesPage';
import { SessionsPage } from './pages/SessionsPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { CustomerPage } from './pages/CustomerPage';
import { AuthPage } from './pages/AuthPage';
import { ClientsPage } from './pages/ClientsPage';
import { ToastProvider } from './components/ui/Toast';
import { api, setUnauthenticatedHandler } from './lib/api';

function getRoute() {
  const m = window.location.pathname.match(/^\/c\/([a-z0-9-]+)/i);
  if (m) return { kind: 'customer', companyId: m[1] };
  return { kind: 'admin' };
}

export default function App() {
  const [route, setRoute] = useState(getRoute());
  const [tab, setTab]     = useState('companies');
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

  // Clients shouldn't see the admin dashboard — redirect to their company page.
  if (user.role === 'client') {
    if (user.companyId) {
      window.location.replace(`/c/${user.companyId}`);
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50" dir="rtl">
        <div className="text-ink-400 text-sm">جارٍ التحويل…</div>
      </div>
    );
  }

  const onLogout = async () => {
    try { await api.logout(); } catch {}
    setUser(null);
  };

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-row-reverse">
        <Sidebar active={tab} onChange={setTab} user={user} onLogout={onLogout} />
        <main className="flex-1 min-w-0">
          {tab === 'companies'  && <CompaniesPage />}
          {tab === 'clients'    && user.role === 'superadmin' && <ClientsPage />}
          {tab === 'sessions'   && <SessionsPage />}
          {tab === 'playground' && <PlaygroundPage />}
        </main>
      </div>
    </ToastProvider>
  );
}
