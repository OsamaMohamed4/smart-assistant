import { useEffect, useState } from 'react';
import { MessageSquare, Mic, Phone, Shield, AlertTriangle, Lock, Mail, LogOut } from 'lucide-react';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';
import { ChatPanel } from '../components/customer/ChatPanel';
import { VoicePanel } from '../components/customer/VoicePanel';
import { PhonePanel } from '../components/customer/PhonePanel';
import { cn } from '../lib/utils';
import { api } from '../lib/api';

const TABS = [
  { id: 'chat',  label: 'محادثة',      icon: MessageSquare, hint: 'كتابة' },
  { id: 'voice', label: 'صوت مباشر',   icon: Mic,           hint: 'تكلم بصوتك' },
  { id: 'phone', label: 'اتصال هاتفي', icon: Phone,         hint: 'مكالمة عادية' },
];

export function CustomerPage({ companyId }) {
  const [company, setCompany] = useState(null);
  const [user, setUser]       = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('chat');

  // Load public company info (name/avatar) in parallel with auth.
  useEffect(() => {
    fetch(`/api/public/companies/${companyId}`)
      .then(async (r) => {
        if (!r.ok) { setError('شركة غير موجودة'); return; }
        setCompany(await r.json());
      })
      .catch(() => setError('تعذّر الاتصال بالخادم'));

    api.me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, [companyId]);

  const onLogout = async () => {
    try { await api.logout(); } catch {}
    setUser(null);
  };

  if (error)         return <NotFound message={error} />;
  if (!company || !authChecked) return <Loading />;

  // /c/<id> is strictly the client experience.
  const isAllowed = user && user.role === 'client' && user.companyId === companyId;

  // Block admins from overwriting their session by accidentally signing in as a
  // client from the same browser tab. The cookie is shared, so a client login
  // here invalidates their admin session everywhere. Show a preview-mode notice
  // instead of the login form — they can open an incognito window to genuinely
  // test the client experience without losing admin access.
  if (!isAllowed && user && user.role !== 'client') {
    return <AdminPreviewNotice company={company} companyId={companyId} onLogout={onLogout} />;
  }

  if (!isAllowed) {
    return <ClientLogin company={company} companyId={companyId} onAuthed={setUser} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-ink-50 to-ink-100/50 relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-[360px] bg-gradient-to-br from-brand-500/[0.08] via-accent-violet/[0.04] to-transparent pointer-events-none" />
      <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-brand-500/[0.06] blur-3xl pointer-events-none" />
      <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-accent-violet/[0.06] blur-3xl pointer-events-none" />

      <div className="relative max-w-3xl mx-auto px-4 py-6 sm:py-10 min-h-screen flex flex-col">
        <div className="flex items-center justify-between mb-6 px-1">
          <div className="flex items-center gap-2 text-ink-500">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-brand-400 to-brand-700 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-white" fill="currentColor">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 1 0 6 0V4a3 3 0 0 0-3-3Zm7 11v-2a1 1 0 1 0-2 0v2a5 5 0 0 1-10 0v-2a1 1 0 1 0-2 0v2a7 7 0 0 0 6 6.92V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 12Z" />
              </svg>
            </div>
            <span className="text-[11.5px] font-medium">Smart Assistant</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
              <Shield className="w-3 h-3" />
              مكالمة مشفّرة
            </div>
            <button onClick={onLogout} className="flex items-center gap-1.5 text-[11.5px] text-ink-500 hover:text-rose-600 transition-colors">
              <LogOut className="w-3 h-3" />
              خروج
            </button>
          </div>
        </div>

        <div className="flex-1 bg-white border border-ink-100 rounded-3xl shadow-pop overflow-hidden flex flex-col">
          <div className="px-5 sm:px-8 py-5 border-b border-ink-100 flex items-center gap-4">
            <div className="relative">
              <Avatar name={company.name} size={52} />
              <span className="absolute -bottom-0.5 -left-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 ring-[3px] ring-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-[18px] font-bold text-ink-900 tracking-tight leading-tight">{company.name}</h1>
              <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-500">
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  أهلاً {user.name || user.email}
                </span>
              </div>
            </div>
            <Badge tone="brand" className="hidden sm:inline-flex">AI</Badge>
          </div>

          <div className="px-5 sm:px-8 pt-4 border-b border-ink-100">
            <div className="flex items-center gap-1 bg-ink-50/80 border border-ink-100 rounded-2xl p-1 w-fit mx-auto sm:mx-0">
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      'h-9 px-4 rounded-xl flex items-center gap-2 text-[13px] font-medium transition-all',
                      active
                        ? 'bg-white text-ink-900 shadow-soft ring-1 ring-ink-100'
                        : 'text-ink-600 hover:text-ink-900',
                    )}
                  >
                    <Icon className={cn('w-3.5 h-3.5', active ? 'text-brand-500' : 'text-ink-500')} strokeWidth={2} />
                    {t.label}
                    <span className={cn('hidden sm:inline text-[10px] px-1.5 py-0.5 rounded',
                      active ? 'bg-ink-100 text-ink-600' : 'text-ink-400')}>{t.hint}</span>
                  </button>
                );
              })}
            </div>
            <div className="h-3" />
          </div>

          <div className="flex-1 min-h-[520px] flex flex-col">
            {tab === 'chat'  && <ChatPanel  company={company} />}
            {tab === 'voice' && <VoicePanel company={company} />}
            {tab === 'phone' && <PhonePanel company={company} />}
          </div>
        </div>

        <div className="text-center mt-5 mb-2 text-[11px] text-ink-400">
          مدعوم بواسطة <span className="text-ink-600 font-semibold">Smart Assistant</span> · جميع المحادثات تُسجّل لتحسين الخدمة
        </div>
      </div>
    </div>
  );
}

function ClientLogin({ company, companyId, onAuthed }) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.login({ email: email.trim(), password });
      // Strict: only accept clients of THIS company. Anything else gets logged out
      // and shown a generic credentials error — no info leak about the rejected role.
      if (r.user.role !== 'client' || r.user.companyId !== companyId) {
        try { await api.logout(); } catch {}
        setError('بيانات الدخول غير صحيحة لهذه الشركة');
        return;
      }
      onAuthed(r.user);
    } catch (err) { setError(err.message || 'تعذّر الدخول'); }
    finally       { setBusy(false); }
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
            تحدث مع {company.name}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-500">
            سجّل دخولك بالبيانات اللي بعتتهالك الشركة.
          </p>
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
              <Label>كلمة السر</Label>
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

          <div className="mt-5 pt-5 border-t border-ink-100 text-center text-[12px] text-ink-500">
            ما عندكش حساب؟ تواصل مع <strong className="text-ink-700">{company.name}</strong> ليُنشئ لك حساب.
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminPreviewNotice({ company, companyId, onLogout }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-ink-50 via-white to-brand-50/40 flex items-center justify-center p-6" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-block relative mb-4">
            <Avatar name={company.name} size={72} />
            <span className="absolute -bottom-1 -left-1 w-5 h-5 rounded-full bg-amber-500 ring-4 ring-white" />
          </div>
          <h1 className="text-[22px] font-bold text-ink-900 tracking-tight">
            صفحة عملاء {company.name}
          </h1>
        </div>

        <div className="bg-white rounded-3xl shadow-pop border border-ink-100 p-7">
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-5">
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-9 h-9 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center">
                <Shield className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <h3 className="text-[14px] font-semibold text-amber-900 mb-1">إنت دلوقتي مسجّل دخول كمدير</h3>
                <p className="text-[12.5px] text-amber-800 leading-relaxed">
                  لو سجّلت دخول هنا بحساب عميل، جلسة الإدارة بتاعتك هتنتهي وهتترجع للوحة التحكم بدور عميل.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2.5 text-[13px] text-ink-700 mb-5">
            <p className="font-semibold text-ink-900">عشان تجرّب تجربة العميل بدون ما تخرج:</p>
            <ol className="list-decimal list-inside space-y-1.5 text-ink-600 pr-1">
              <li>افتح نافذة <strong className="text-ink-900">incognito / private</strong> في المتصفح</li>
              <li>الصق نفس الرابط: <code className="bg-ink-100 px-1.5 py-0.5 rounded text-[11.5px] font-mono" dir="ltr">/c/{companyId}</code></li>
              <li>سجّل دخول هناك بحساب العميل بدون ما تأثر على جلستك دي</li>
            </ol>
          </div>

          <div className="flex flex-col gap-2 pt-4 border-t border-ink-100">
            <a
              href="/admin/"
              className="w-full h-11 rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-[13.5px] font-semibold flex items-center justify-center transition-colors"
            >
              الرجوع للوحة التحكم
            </a>
            <button
              onClick={onLogout}
              className="w-full h-11 rounded-xl border border-ink-200 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 text-ink-700 text-[13.5px] font-medium flex items-center justify-center gap-2 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              تسجيل خروج وتسجيل دخول بحساب عميل
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NotFound({ message }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-ink-50">
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
    <div className="min-h-screen flex items-center justify-center bg-ink-50">
      <div className="w-8 h-8 border-2 border-ink-300 border-t-brand-500 rounded-full animate-spin" />
    </div>
  );
}
