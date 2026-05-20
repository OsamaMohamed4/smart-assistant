import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Bot, User, RotateCcw, Volume2, Zap, MessagesSquare } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Avatar } from '../components/ui/Avatar';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, relTime, fmtNumber } from '../lib/utils';

export function PlaygroundPage() {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [activeCompany, setActiveCompany] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api.listCompanies().then((list) => {
      setCompanies(list);
      if (list[0]) setActiveCompany(list[0]);
    }).catch((e) => push(e.message, 'error'));
  }, []);

  useEffect(() => {
    if (!activeCompany) return;
    api.listSessions(activeCompany.id, 25).then(setSessions);
  }, [activeCompany]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const newSession = () => {
    setSessionId(null);
    setMessages([]);
    inputRef.current?.focus();
  };

  const loadSession = async (sid) => {
    setSessionId(sid);
    const rows = await api.getSession(sid);
    const ms = [];
    rows.forEach((r) => {
      ms.push({ role: 'user', content: r.user_message, time: r.created_at });
      if (r.assistant_reply) ms.push({ role: 'assistant', content: r.assistant_reply, latency: r.latency_ms, time: r.created_at });
    });
    setMessages(ms);
  };

  const send = async () => {
    if (!input.trim() || !activeCompany || busy) return;
    const text = input.trim();
    setInput('');
    const sid = sessionId || `pg-${Date.now()}`;
    if (!sessionId) setSessionId(sid);

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: text, time: new Date().toISOString() }]);
    setBusy(true);
    try {
      const r = await api.chat({ companyId: activeCompany.id, message: text, sessionId: sid, history });
      setMessages((m) => [...m, { role: 'assistant', content: r.reply, latency: r.ms, time: new Date().toISOString() }]);
      // refresh sessions in sidebar
      api.listSessions(activeCompany.id, 25).then(setSessions);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: e.message, error: true, time: new Date().toISOString() }]);
      push(e.message, 'error');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ─── Right pane: chat ─── */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          title="التجربة"
          subtitle={activeCompany ? `جاري التحدث مع: ${activeCompany.name}` : 'اختر شركة لتبدأ'}
          right={
            <div className="flex items-center gap-2">
              <Badge tone="brand" dot>gpt-4o-mini</Badge>
              <Button variant="secondary" size="md" onClick={newSession} className="gap-1.5">
                <RotateCcw className="w-3.5 h-3.5" /> جلسة جديدة
              </Button>
            </div>
          }
        />

        <div ref={scroller} className="flex-1 overflow-y-auto px-8 py-6">
          {!activeCompany ? (
            <EmptyState icon={MessagesSquare} title="اختر شركة من اليمين" description="هتقدر تجرّب المساعد قبل ما تعرّضه للعملاء." />
          ) : messages.length === 0 ? (
            <WelcomeCard company={activeCompany} onPick={(q) => { setInput(q); inputRef.current?.focus(); }} />
          ) : (
            <div className="max-w-3xl mx-auto space-y-5">
              {messages.map((m, i) => (
                <Message key={i} role={m.role} content={m.content} latency={m.latency} time={m.time} company={activeCompany} error={m.error} />
              ))}
              {busy && <TypingIndicator company={activeCompany} />}
            </div>
          )}
        </div>

        {/* ─── Input area ─── */}
        <div className="border-t border-ink-100 bg-white px-8 py-4">
          <div className="max-w-3xl mx-auto">
            <div className="relative bg-white border border-ink-200 rounded-2xl shadow-soft focus-within:border-ink-400 focus-within:shadow-glow transition-all duration-150">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                disabled={!activeCompany}
                rows={1}
                placeholder={activeCompany ? `اكتب رسالتك إلى ${activeCompany.name}...` : 'اختر شركة أولاً'}
                className="w-full resize-none bg-transparent rounded-2xl px-4 py-3.5 pl-14 text-[14px] placeholder:text-ink-400 outline-none font-arabic leading-relaxed max-h-40"
                style={{ minHeight: 50 }}
              />
              <button
                onClick={send}
                disabled={!input.trim() || busy || !activeCompany}
                className={cn(
                  'absolute left-2 bottom-2 w-9 h-9 rounded-xl flex items-center justify-center transition-all',
                  input.trim() && !busy ? 'bg-ink-900 text-white hover:bg-ink-800 shadow-soft' : 'bg-ink-100 text-ink-400',
                  'disabled:cursor-not-allowed',
                )}
              >
                <Send className="w-3.5 h-3.5" strokeWidth={2.5} />
              </button>
            </div>
            <div className="flex items-center justify-between mt-2.5 px-1">
              <div className="flex items-center gap-2 text-[11px] text-ink-500">
                <kbd className="bg-ink-100 px-1.5 py-0.5 rounded font-mono text-[10px]">Enter</kbd> للإرسال
                <span className="text-ink-300">·</span>
                <kbd className="bg-ink-100 px-1.5 py-0.5 rounded font-mono text-[10px]">Shift + Enter</kbd> لسطر جديد
              </div>
              {sessionId && (
                <div className="text-[11px] text-ink-500 font-mono">
                  session: <span className="text-ink-700">{sessionId.slice(0, 16)}…</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Left pane: sidebar (companies + sessions) ─── */}
      <div className="w-[300px] shrink-0 border-l border-ink-100 bg-white flex flex-col h-screen">
        <div className="px-4 py-4 border-b border-ink-100">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-500 mb-2">الشركة</div>
          <div className="space-y-1">
            {companies.map((c) => (
              <button
                key={c.id}
                onClick={() => { setActiveCompany(c); newSession(); }}
                className={cn(
                  'w-full flex items-center gap-3 p-2 rounded-xl text-right transition-colors',
                  activeCompany?.id === c.id ? 'bg-ink-100' : 'hover:bg-ink-50',
                )}
              >
                <Avatar name={c.name} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink-900 truncate">{c.name}</div>
                  <div className="text-[11px] text-ink-500 font-mono truncate">{c.id}</div>
                </div>
                {activeCompany?.id === c.id && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-500 mb-2 flex items-center justify-between">
            <span>الجلسات السابقة</span>
            <span className="tabular-nums text-ink-400">{sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="text-[12px] text-ink-400 px-2 py-4">ما فيه جلسات بعد</div>
          ) : (
            <div className="space-y-0.5">
              {sessions.map((s) => (
                <button
                  key={s.session_id}
                  onClick={() => loadSession(s.session_id)}
                  className={cn(
                    'w-full text-right p-2 rounded-lg transition-colors',
                    sessionId === s.session_id ? 'bg-brand-50 ring-1 ring-brand-200/60' : 'hover:bg-ink-50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-[11.5px] font-mono text-ink-600 truncate">{s.session_id.slice(0, 18)}</span>
                    <span className="text-[10.5px] text-ink-400 shrink-0">{s.messages} رس</span>
                  </div>
                  <div className="text-[11px] text-ink-500 truncate">{s.summary || relTime(s.last_at)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Message({ role, content, latency, time, company, error }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex gap-3 animate-slide-up', isUser && 'flex-row-reverse')}>
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-8 h-8 rounded-xl bg-ink-900 text-white flex items-center justify-center">
            <User className="w-3.5 h-3.5" strokeWidth={2.2} />
          </div>
        ) : (
          <Avatar name={company.name} size={32} />
        )}
      </div>
      <div className={cn('flex-1 min-w-0', isUser ? 'pl-12' : 'pr-12')}>
        <div className={cn('flex items-center gap-2 mb-1', isUser && 'flex-row-reverse')}>
          <span className="text-[12px] font-semibold text-ink-700">{isUser ? 'أنت' : company.name}</span>
          <span className="text-[10.5px] text-ink-400">{relTime(time)}</span>
          {!isUser && latency ? (
            <Badge tone="neutral" className="text-[9.5px] !py-0"><Zap className="w-2.5 h-2.5" />{latency}ms</Badge>
          ) : null}
        </div>
        <div className={cn(
          'inline-block max-w-full rounded-2xl px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap',
          isUser
            ? 'bg-ink-900 text-white shadow-soft'
            : error
              ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200'
              : 'bg-white text-ink-800 ring-1 ring-ink-100 shadow-soft',
        )}>
          {content}
        </div>
      </div>
    </div>
  );
}

function TypingIndicator({ company }) {
  return (
    <div className="flex gap-3 animate-fade-in">
      <Avatar name={company.name} size={32} />
      <div className="bg-white ring-1 ring-ink-100 rounded-2xl px-4 py-3.5 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  );
}

function WelcomeCard({ company, onPick }) {
  const suggestions = [
    'كم سعر تذكرة من الرياض إلى دبي؟',
    'وش الأمتعة المسموحة؟',
    'سياسة الإلغاء عندكم وش هي؟',
    'وش وسائل الدفع المتاحة؟',
  ];
  return (
    <div className="max-w-2xl mx-auto pt-12">
      <div className="text-center mb-8">
        <Avatar name={company.name} size={64} className="mx-auto" />
        <h2 className="mt-5 text-[22px] font-bold text-ink-900 tracking-tight">جرّب {company.name}</h2>
        <p className="mt-2 text-[14px] text-ink-500 max-w-md mx-auto leading-relaxed">
          اختبر المساعد قبل ما العملاء يتعاملوا معاه. كل رسالة بتُسجّل ويمكن تلخيصها لاحقاً من تبويب السجلات.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {suggestions.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="text-right p-3.5 bg-white border border-ink-100 rounded-xl hover:border-ink-300 hover:shadow-soft hover:-translate-y-0.5 transition-all group"
          >
            <div className="flex items-start gap-2.5">
              <div className="w-6 h-6 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0 group-hover:bg-brand-500 group-hover:text-white transition-colors">
                <Sparkles className="w-3 h-3" strokeWidth={2} />
              </div>
              <span className="text-[13px] text-ink-700 leading-relaxed">{q}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
