import { useState } from 'react';
import { Mail, Lock, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { Input, Label } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { MasarLogo } from '../components/ui/MasarMark';
import { api } from '../lib/api';

// The single front door, linked from the public site.
//
// It exists because the branded workspace lives at /c/<companyId> and a
// visitor arriving from masargrup.com has no way to know their company id.
// They sign in with an email, and the server's answer — which carries the
// role and company — decides where they land. The destination is NEVER read
// from the URL or from anything the visitor can set.
//
// «نسيت كلمة المرور؟» switches the card to the reset request: the account's
// own mailbox gets a one-hour, one-use link (/reset-password). /login?forgot=1
// opens straight on it — the company sign-in pages link there.
export function landingFor(u) {
  if (u?.role === 'client' && u.companyId) return `/c/${encodeURIComponent(u.companyId)}`;
  if (u?.role === 'superadmin') return '/admin/';
  return null;
}

export function LoginPage() {
  const [mode, setMode] = useState(() => (new URLSearchParams(window.location.search).has('forgot') ? 'forgot' : 'login'));

  return (
    <div className="min-h-screen bg-gradient-to-br from-ink-50 via-white to-brand-50/40 flex items-center justify-center p-6" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <MasarLogo className="h-16 mx-auto" />
          <h1 className="mt-5 text-[22px] font-bold text-ink-900 tracking-tight">
            {mode === 'forgot' ? 'استعادة كلمة المرور' : 'تسجيل الدخول'}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-500">
            {mode === 'forgot' ? 'أدخل بريدك وسنرسل لك رابطاً لتعيين كلمة مرور جديدة.' : 'أهلاً بعودتك إلى مسار'}
          </p>
        </div>

        <div className="bg-white rounded-3xl shadow-pop border border-ink-100 p-7">
          {mode === 'forgot'
            ? <ForgotForm onBack={() => setMode('login')} />
            : <SignInForm onForgot={() => setMode('forgot')} />}
        </div>

        <p className="mt-6 text-center text-[11px] text-ink-400">
          باستخدامك للخدمة فإنك توافق على{' '}
          <a href="/terms" className="underline hover:text-ink-600">شروط الخدمة</a>{' '}
          و<a href="/privacy" className="underline hover:text-ink-600">سياسة الخصوصية</a>.
        </p>
      </div>
    </div>
  );
}

function ErrorBox({ children }) {
  return (
    <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-[12.5px]">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function SignInForm({ onForgot }) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.login({ email: email.trim(), password });
      // A full page load, not a client-side route change: /admin and
      // /c/<id> are separate entry points on the server and the admin one is
      // only served to a session that is already allowed to see it.
      const dest = landingFor(r.user);
      if (dest) {
        window.location.assign(dest);
      } else {
        // A real account with no company and no admin role has nowhere to be
        // sent. Saying so is better than a redirect loop.
        setError('هذا الحساب غير مرتبط بأي شركة. تواصل مع مسؤول النظام.');
        setBusy(false);
      }
    } catch (err) {
      setError(err.message || 'حدث خطأ، حاول مرة أخرى');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label>البريد الإلكتروني</Label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required
          leftIcon={<Mail className="w-3.5 h-3.5" />} autoComplete="email" dir="ltr" />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <Label>كلمة المرور</Label>
          <button type="button" onClick={onForgot} className="text-[11.5px] text-brand-600 hover:text-brand-700 mb-1.5">
            نسيت كلمة المرور؟
          </button>
        </div>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required
          leftIcon={<Lock className="w-3.5 h-3.5" />} autoComplete="current-password" dir="ltr" />
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <Button variant="brand" size="lg" loading={busy} className="w-full mt-2">دخول</Button>
    </form>
  );
}

function ForgotForm({ onBack }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy]   = useState(false);
  const [sent, setSent]   = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err.message || 'حدث خطأ، حاول مرة أخرى');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    // The same words whether or not the address has an account.
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-[13px] text-emerald-900 leading-relaxed">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            إذا كان البريد <span dir="ltr" className="font-medium">{email.trim()}</span> مسجّلاً لدينا، ستصلك خلال دقائق رسالة فيها رابط
            لتعيين كلمة مرور جديدة. الرابط صالح لمدة ساعة ولمرة واحدة. تحقق من مجلد الرسائل غير المرغوب فيها إن لم تجدها.
          </span>
        </div>
        <Button variant="secondary" size="lg" className="w-full" onClick={onBack}>
          <ArrowRight className="w-4 h-4" /> العودة لتسجيل الدخول
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label>البريد الإلكتروني</Label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required
          leftIcon={<Mail className="w-3.5 h-3.5" />} autoComplete="email" dir="ltr" autoFocus />
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <Button variant="brand" size="lg" loading={busy} className="w-full">إرسال رابط التعيين</Button>
      <button type="button" onClick={onBack} className="w-full text-center text-[12.5px] text-ink-500 hover:text-ink-800">
        العودة لتسجيل الدخول
      </button>
    </form>
  );
}
