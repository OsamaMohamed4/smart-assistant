import { useState } from 'react';
import { Mail, Lock, AlertCircle } from 'lucide-react';
import { Input, Label } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { MasarMark } from '../components/ui/MasarMark';
import { api } from '../lib/api';

// The single front door, linked from the public site.
//
// It exists because the branded workspace lives at /c/<companyId> and a
// visitor arriving from masargrup.com has no way to know their company id.
// They sign in with an email, and the server's answer — which carries the
// role and company — decides where they land. The destination is NEVER read
// from the URL or from anything the visitor can set.
export function LoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [forgot, setForgot]     = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.login({ email: email.trim(), password });
      const u = r.user || {};
      // A full page load, not a client-side route change: /admin and
      // /c/<id> are separate entry points on the server and the admin one is
      // only served to a session that is already allowed to see it.
      if (u.role === 'client' && u.companyId) {
        window.location.assign(`/c/${encodeURIComponent(u.companyId)}`);
      } else if (u.role === 'superadmin') {
        window.location.assign('/admin/');
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
    <div className="min-h-screen bg-gradient-to-br from-ink-50 via-white to-brand-50/40 flex items-center justify-center p-6" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <MasarMark className="h-9 mx-auto text-brand-600" title="مسار" />
          <h1 className="mt-5 text-[22px] font-bold text-ink-900 tracking-tight">تسجيل الدخول</h1>
          <p className="mt-1.5 text-[13px] text-ink-500">أهلاً بعودتك إلى مسار</p>
        </div>

        <div className="bg-white rounded-3xl shadow-pop border border-ink-100 p-7">
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
              <div className="flex items-center justify-between">
                <Label>كلمة المرور</Label>
                <button
                  type="button"
                  onClick={() => setForgot((v) => !v)}
                  className="text-[11.5px] text-brand-600 hover:text-brand-700 mb-1.5"
                >
                  نسيت كلمة المرور؟
                </button>
              </div>
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
              {/* Says what actually happens instead of offering a "send reset
                  link" button that would do nothing: the platform has no mail
                  transport, so a reset is issued by an operator from the
                  Clients screen and handed over directly. A dead button that
                  claims an email is on its way is worse than the truth. */}
              {forgot && (
                <div className="mt-2.5 rounded-xl bg-brand-50 border border-brand-200 px-3.5 py-2.5 text-[12px] text-ink-700 leading-relaxed">
                  إعادة التعيين تتم عبر مسؤول النظام — يصدر لك كلمة مرور جديدة
                  ويسلّمها لك مباشرة.{' '}
                  <a href="/contact" className="text-brand-700 underline">تواصل معنا</a>
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-[12.5px]">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button variant="brand" size="lg" loading={busy} className="w-full mt-2">دخول</Button>
          </form>
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
