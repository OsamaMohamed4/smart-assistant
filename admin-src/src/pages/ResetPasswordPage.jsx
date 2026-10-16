import { useEffect, useState } from 'react';
import { Lock, AlertCircle } from 'lucide-react';
import { Input, Label } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { MasarMark } from '../components/ui/MasarMark';
import { api } from '../lib/api';
import { landingFor } from './LoginPage';

// Where a password-reset or sign-in link lands (/reset-password?token=…).
// The token is read once and taken out of the address bar, so it does not
// linger in history or get copied along with the URL. The server says
// whether the link is still good before anyone types a password; setting it
// spends the link and signs the person in.
const MIN = 8;

export function ResetPasswordPage() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [link, setLink]         = useState(null);      // { valid, purpose, email }
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    try { window.history.replaceState(null, '', '/reset-password'); } catch { /* old browser */ }
    if (!token) { setLink({ valid: false }); return; }
    api.checkResetLink(token).then(setLink).catch(() => setLink({ valid: false }));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < MIN || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      setError(`يجب أن تتكوّن كلمة المرور من ${MIN} أحرف على الأقل، وتتضمّن حرفاً ورقماً.`);
      return;
    }
    if (password !== confirm) { setError('كلمتا المرور غير متطابقتين'); return; }
    setBusy(true);
    try {
      const r = await api.resetPassword(token, password);
      window.location.assign(landingFor(r.user) || '/login');
    } catch (err) {
      setError(err.message || 'حدث خطأ، حاول مرة أخرى');
      setBusy(false);
    }
  };

  const invite = link?.purpose === 'invite';
  return (
    <div className="min-h-screen bg-gradient-to-br from-ink-50 via-white to-brand-50/40 flex items-center justify-center p-6" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <MasarMark className="h-9 mx-auto text-brand-600" title="مسار" />
          <h1 className="mt-5 text-[22px] font-bold text-ink-900 tracking-tight">
            {invite ? 'تعيين كلمة المرور' : 'كلمة مرور جديدة'}
          </h1>
          {link?.valid && (
            <p className="mt-1.5 text-[13px] text-ink-500">
              للحساب <span dir="ltr" className="font-medium text-ink-700">{link.email}</span>
            </p>
          )}
        </div>

        <div className="bg-white rounded-3xl shadow-pop border border-ink-100 p-7">
          {!link ? (
            <div className="text-center text-[13px] text-ink-400 py-6">جارٍ التحقق من الرابط…</div>
          ) : !link.valid ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 px-3.5 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-[13px] leading-relaxed">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب رابطاً جديداً.</span>
              </div>
              <Button variant="brand" size="lg" className="w-full" onClick={() => window.location.assign('/login?forgot=1')}>
                طلب رابط جديد
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label hint={`${MIN}+ أحرف، حرف ورقم على الأقل`}>كلمة المرور الجديدة</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required
                  leftIcon={<Lock className="w-3.5 h-3.5" />} autoComplete="new-password" dir="ltr" autoFocus />
              </div>
              <div>
                <Label>تأكيد كلمة المرور</Label>
                <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required
                  leftIcon={<Lock className="w-3.5 h-3.5" />} autoComplete="new-password" dir="ltr" />
              </div>
              {error && (
                <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-[12.5px]">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <Button variant="brand" size="lg" loading={busy} className="w-full mt-2">
                {invite ? 'حفظ والدخول' : 'تغيير كلمة المرور والدخول'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
