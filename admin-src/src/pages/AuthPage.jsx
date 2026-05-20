import { useState, useEffect } from 'react';
import { Mail, Lock, User, ShieldCheck, AlertCircle, Sparkles } from 'lucide-react';
import { Input, Label } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

export function AuthPage({ onAuthed }) {
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [mode, setMode]         = useState('login');
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');

  // Probe whether the first-user bootstrap is still available.
  useEffect(() => {
    api.bootstrapOpen()
      .then((r) => {
        setBootstrapOpen(!!r.open);
        if (r.open) setMode('signup');
      })
      .catch(() => setBootstrapOpen(false));
  }, []);

  const isSignup = mode === 'signup';

  const submit = async (e) => {
    e.preventDefault();
    setError('');

    if (isSignup) {
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        setError('كلمة السر لازم تكون 8 أحرف على الأقل وتحتوي على حرف ورقم');
        return;
      }
      if (password !== confirm) {
        setError('كلمتا السر غير متطابقتين');
        return;
      }
    }

    setBusy(true);
    try {
      const fn = isSignup ? api.signup : api.login;
      const body = isSignup
        ? { name: name.trim(), email: email.trim(), password }
        : { email: email.trim(), password };
      const r = await fn(body);
      onAuthed(r.user);
    } catch (err) {
      setError(err.message || 'حصل خطأ، حاول مرة ثانية');
    } finally {
      setBusy(false);
    }
  };

  const pwStrength = isSignup ? getStrength(password) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-ink-50 via-white to-brand-50/40 flex items-center justify-center p-6" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-[0_8px_28px_rgba(91,91,214,0.35)] mb-4">
            <ShieldCheck className="w-7 h-7 text-white" strokeWidth={2} />
          </div>
          <h1 className="text-[22px] font-bold text-ink-900 tracking-tight">
            {isSignup ? 'إعداد المنصّة' : 'تسجيل الدخول'}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-500">
            {isSignup
              ? 'أنشئ حساب المسؤول الرئيسي للمنصّة'
              : 'أهلاً بعودتك إلى Smart Assistant'}
          </p>
          {isSignup && bootstrapOpen && (
            <div className="mt-4 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-[11.5px] text-amber-800">
              <Sparkles className="w-3 h-3" />
              أول حساب يُنشأ تلقائياً كمسؤول النظام
            </div>
          )}
        </div>

        <div className="bg-white rounded-3xl shadow-pop border border-ink-100 p-7">
          <form onSubmit={submit} className="space-y-4">
            {isSignup && (
              <div>
                <Label>الاسم</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="اسمك الكامل"
                  leftIcon={<User className="w-3.5 h-3.5" />}
                  autoComplete="name"
                />
              </div>
            )}

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
              <Label hint={isSignup ? '8+ أحرف، حرف ورقم على الأقل' : null}>كلمة السر</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={isSignup ? 8 : undefined}
                leftIcon={<Lock className="w-3.5 h-3.5" />}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                dir="ltr"
              />
              {isSignup && password && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${pwStrength.color}`}
                      style={{ width: `${pwStrength.percent}%` }}
                    />
                  </div>
                  <span className={`text-[11px] font-medium ${pwStrength.textColor}`}>{pwStrength.label}</span>
                </div>
              )}
            </div>

            {isSignup && (
              <div>
                <Label>تأكيد كلمة السر</Label>
                <Input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••"
                  required
                  leftIcon={<Lock className="w-3.5 h-3.5" />}
                  autoComplete="new-password"
                  dir="ltr"
                />
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-[12.5px]">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button variant="brand" size="lg" loading={busy} className="w-full mt-2">
              {isSignup ? 'إنشاء حساب المسؤول' : 'دخول'}
            </Button>
          </form>

          {!isSignup && (
            <div className="mt-5 pt-5 border-t border-ink-100 text-center text-[12px] text-ink-500 leading-relaxed">
              التسجيل الذاتي مغلق.<br />
              تواصل مع مسؤول النظام أو الشركة التي تتعامل معها لإنشاء حسابك.
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-ink-400">
          باستخدامك للخدمة فإنك توافق على شروط الاستخدام وسياسة الخصوصية.
        </p>
      </div>
    </div>
  );
}

function getStrength(pw) {
  let s = 0;
  if (pw.length >= 8)  s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw))   s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const labels = [
    { label: 'ضعيفة جداً', color: 'bg-rose-500',   textColor: 'text-rose-600',   percent: 20 },
    { label: 'ضعيفة',      color: 'bg-orange-500', textColor: 'text-orange-600', percent: 40 },
    { label: 'متوسطة',     color: 'bg-amber-500',  textColor: 'text-amber-600',  percent: 60 },
    { label: 'قوية',       color: 'bg-emerald-500',textColor: 'text-emerald-600',percent: 80 },
    { label: 'قوية جداً',  color: 'bg-emerald-600',textColor: 'text-emerald-700',percent: 100 },
  ];
  return labels[Math.min(s, labels.length - 1)];
}
