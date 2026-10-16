import { useEffect, useState } from 'react';
import { AlertTriangle, Mail, Lock, LogOut } from 'lucide-react';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';
import { api } from '../lib/api';

// Wraps a workspace URL (`/c/<companyId>`) and only renders its `render` prop
// when the visitor is authenticated and authorised for this specific company.
// Otherwise it shows a branded login form for the company.
export function WorkspaceGate({ companyId, user, onAuthed, onLogout, render }) {
  const [company, setCompany] = useState(null);
  const [error, setError]     = useState(null);

  useEffect(() => {
    fetch(`/api/public/companies/${companyId}`)
      .then(async (r) => {
        if (!r.ok) { setError('شركة غير موجودة'); return; }
        setCompany(await r.json());
      })
      .catch(() => setError('تعذّر الاتصال بالخادم'));
  }, [companyId]);

  // A client account granted this company as well as its own: the session is
  // moved here first (the server checks the grant), then the page renders.
  const mayWorkHere = user?.role === 'client' && user?.companyId !== companyId
    && (user?.companies || []).some((c) => c.id === companyId);
  useEffect(() => {
    if (!mayWorkHere) return;
    api.switchCompany(companyId).then((r) => onAuthed(r.user)).catch((e) => setError(e.message));
  }, [mayWorkHere, companyId]);

  // Two tabs on two companies share one session. Whichever tab the user comes
  // back to takes the session back to its own company, so its requests are
  // answered for the company it shows rather than refused.
  const multi = user?.role === 'client' && (user?.companies || []).length > 1;
  useEffect(() => {
    if (!multi) return undefined;
    const resync = () => {
      if (document.visibilityState !== 'visible') return;
      api.me().then((r) => {
        const u = r.user;
        if (u?.companyId !== companyId && (u?.companies || []).some((c) => c.id === companyId)) {
          return api.switchCompany(companyId);
        }
        return null;
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('focus', resync);
    return () => {
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('focus', resync);
    };
  }, [multi, companyId]);

  if (error)   return <NotFound message={error} />;
  if (!company || mayWorkHere) return <Loading />;

  // Allowed: a client of THIS company, or any superadmin (they can preview
  // any workspace). Anyone else has to log in or switch accounts.
  const isClientOfThis = user?.role === 'client' && user?.companyId === companyId;
  const isSuper        = user?.role === 'superadmin';
  const authorised     = isClientOfThis || isSuper;

  if (!authorised) {
    return (
      <ClientLogin
        company={company}
        companyId={companyId}
        currentUser={user}
        onAuthed={onAuthed}
        onLogout={onLogout}
      />
    );
  }

  return render({ pinnedCompanyId: companyId, onLogout });
}

function ClientLogin({ company, companyId, currentUser, onAuthed, onLogout }) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');

  // If the visitor is currently signed in but to the wrong account, log them
  // out first when they submit fresh credentials — we never silently keep two
  // identities in one tab.
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (currentUser) { try { await api.logout(); } catch {} }
      const r = await api.login({ email: email.trim(), password });
      const granted = r.user.role === 'client'
        && (r.user.companyId === companyId || (r.user.companies || []).some((c) => c.id === companyId));
      const ok = granted || r.user.role === 'superadmin';
      if (!ok) {
        try { await api.logout(); } catch {}
        setError('بيانات الدخول غير صحيحة لهذه الشركة');
        return;
      }
      // An account that works in several companies signs in to its home one;
      // move the session to the company this page belongs to.
      if (r.user.role === 'client' && r.user.companyId !== companyId) {
        onAuthed((await api.switchCompany(companyId)).user);
        return;
      }
      onAuthed(r.user);
    } catch (err) {
      setError(err.message || 'تعذّر الدخول');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-ink-50 via-white to-brand-50/40 flex items-center justify-center p-6" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-block relative mb-4">
            <Avatar name={company.name} size={72} />
            <span className="absolute -bottom-1 -left-1 w-5 h-5 rounded-full bg-emerald-500 ring-4 ring-white" />
          </div>
          <h1 className="text-[22px] font-bold text-ink-900 tracking-tight">
            لوحة تحكم {company.name}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-500">
            سجّل دخولك ببيانات الإدارة.
          </p>
        </div>

        <div className="bg-white rounded-3xl shadow-pop border border-ink-100 p-7">
          {currentUser && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-[12.5px] text-amber-900 leading-relaxed">
              أنت مسجّل بحساب <strong>{currentUser.email}</strong> غير مصرّح له بـ <strong>{company.name}</strong>. سجّل دخول بحساب آخر أو <button type="button" onClick={onLogout} className="underline underline-offset-2 font-semibold">سجّل خروج</button>.
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label>البريد الإلكتروني</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                leftIcon={<Mail className="w-3.5 h-3.5" />}
                autoComplete="email"
                dir="ltr"
              />
            </div>

            <div>
              <Label>كلمة المرور</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                leftIcon={<Lock className="w-3.5 h-3.5" />}
                autoComplete="current-password"
                dir="ltr"
              />
            </div>

            {error && (
              <div className="text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{error}</div>
            )}

            <Button variant="brand" size="lg" loading={busy} className="w-full mt-2">دخول</Button>
          </form>
        </div>
      </div>
    </div>
  );
}

function NotFound({ message }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-ink-50" dir="rtl">
      <div className="max-w-md w-full bg-white border border-ink-100 rounded-2xl p-8 text-center shadow-card">
        <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 mx-auto flex items-center justify-center mb-4">
          <AlertTriangle className="w-5 h-5" />
        </div>
        <h2 className="text-[18px] font-bold text-ink-900 mb-1">{message}</h2>
        <p className="text-[13px] text-ink-500">تأكد من الرابط أو تواصل مع الإدارة.</p>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-50" dir="rtl">
      <div className="w-8 h-8 border-2 border-ink-300 border-t-brand-500 rounded-full animate-spin" />
    </div>
  );
}
