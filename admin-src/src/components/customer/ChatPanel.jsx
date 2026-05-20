import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, ArrowDown } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { cn, relTime } from '../../lib/utils';
import { api } from '../../lib/api';

const STARTERS = {
  acme: [
    'كم سعر تذكرة من الرياض إلى دبي؟',
    'سياسة الإلغاء والاسترداد عندكم؟',
    'وش الأمتعة المسموحة في الاقتصادي؟',
    'في تقسيط على التذاكر؟',
  ],
  techstore: [
    'أبي لابتوب قوي للبرمجة، وش ترشّحون؟',
    'كم سعر iPhone 15؟',
    'في ضمان كم على الأجهزة؟',
    'وش وسائل الدفع المتاحة؟',
  ],
  default: [
    'مرحباً، أبي أعرف عن خدماتكم',
    'كيف أقدر أتواصل معكم؟',
    'وش وسائل الدفع المقبولة؟',
  ],
};

export function ChatPanel({ company }) {
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [busy, setBusy]           = useState(false);
  const [sessionId]               = useState(`cust-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  const [showJump, setShowJump]   = useState(false);
  const scroller                  = useRef(null);
  const inputRef                  = useRef(null);

  const starters = STARTERS[company.id] || STARTERS.default;

  const scrollToBottom = (smooth = true) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => { scrollToBottom(); }, [messages.length, busy]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setShowJump(!atBottom && messages.length > 0);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [messages.length]);

  const send = async (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setInput('');
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: text, time: new Date().toISOString() }]);
    setBusy(true);
    try {
      const r = await api.chat({ companyId: company.id, message: text, sessionId, history });
      setMessages((m) => [...m, { role: 'assistant', content: r.reply, latency: r.ms, time: new Date().toISOString() }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `عذراً، حصل خطأ مؤقت. حاول مرة ثانية.`, error: true, time: new Date().toISOString() }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col h-full">
      {/* ─── Messages scroller ─── */}
      <div ref={scroller} className="flex-1 overflow-y-auto px-5 sm:px-8 py-6 relative">
        {messages.length === 0 ? (
          <Welcome company={company} starters={starters} onPick={(q) => send(q)} />
        ) : (
          <div className="max-w-2xl mx-auto space-y-5">
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} time={m.time} company={company} error={m.error} />
            ))}
            {busy && <Typing company={company} />}
          </div>
        )}

        {showJump && (
          <button
            onClick={() => scrollToBottom()}
            className="sticky bottom-4 float-left mr-auto bg-white shadow-pop border border-ink-200 rounded-full w-10 h-10 flex items-center justify-center text-ink-700 hover:bg-ink-50 transition-colors animate-fade-in"
            aria-label="انتقل للأسفل"
          >
            <ArrowDown className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ─── Input bar ─── */}
      <div className="border-t border-ink-100 bg-white px-5 sm:px-8 py-4">
        <div className="max-w-2xl mx-auto">
          <div className={cn(
            'relative bg-white border rounded-2xl transition-all duration-150',
            busy ? 'border-ink-200 opacity-70' : 'border-ink-200 focus-within:border-ink-400 focus-within:shadow-glow',
          )}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              disabled={busy}
              placeholder="اكتب رسالتك هنا..."
              className="w-full resize-none bg-transparent rounded-2xl px-4 py-3.5 pl-14 text-[15px] placeholder:text-ink-400 outline-none font-arabic leading-relaxed max-h-32"
              style={{ minHeight: 52 }}
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || busy}
              className={cn(
                'absolute left-2 bottom-2 w-10 h-10 rounded-xl flex items-center justify-center transition-all',
                input.trim() && !busy
                  ? 'bg-brand-500 text-white hover:bg-brand-600 shadow-soft'
                  : 'bg-ink-100 text-ink-400',
                'disabled:cursor-not-allowed',
              )}
              aria-label="إرسال"
            >
              <Send className="w-4 h-4" strokeWidth={2.4} />
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-400 text-center">
            ردود المساعد تعتمد على معلومات الشركة. للتأكد من العروض الحديثة تواصل مع الفريق مباشرة.
          </p>
        </div>
      </div>
    </div>
  );
}

function Welcome({ company, starters, onPick }) {
  return (
    <div className="max-w-2xl mx-auto pt-6 sm:pt-12">
      <div className="text-center mb-8">
        <div className="inline-block relative mb-5">
          <Avatar name={company.name} size={64} />
          <div className="absolute -bottom-1 -left-1 w-5 h-5 rounded-full bg-emerald-500 ring-4 ring-white" />
        </div>
        <h2 className="text-[22px] font-bold text-ink-900 tracking-tight">أهلاً وسهلاً</h2>
        <p className="mt-2 text-[14px] text-ink-500 max-w-md mx-auto leading-relaxed">
          أنا المساعد الذكي لـ <span className="text-ink-800 font-semibold">{company.name}</span>،
          متواجد 24/7 للرد على استفساراتك بسرعة.
        </p>
      </div>

      <div className="space-y-2.5">
        <div className="text-[11px] font-semibold text-ink-500 uppercase tracking-wider px-1">جرّب أن تسأل:</div>
        {starters.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="w-full group text-right px-4 py-3.5 bg-white border border-ink-100 rounded-2xl hover:border-ink-300 hover:shadow-soft hover:-translate-y-0.5 transition-all"
          >
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0 group-hover:bg-brand-500 group-hover:text-white transition-colors">
                <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
              </div>
              <span className="text-[14px] text-ink-800 leading-relaxed">{q}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ role, content, time, company, error }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex gap-2.5 animate-slide-up', isUser && 'flex-row-reverse')}>
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-8 h-8 rounded-xl bg-ink-200 text-ink-700 text-[12px] font-bold flex items-center justify-center">
            أنت
          </div>
        ) : (
          <Avatar name={company.name} size={32} />
        )}
      </div>
      <div className={cn('flex-1 min-w-0 max-w-[85%]', isUser ? 'pl-8' : 'pr-8')}>
        <div className={cn('flex items-center gap-2 mb-1 px-1', isUser && 'flex-row-reverse')}>
          <span className="text-[11px] font-semibold text-ink-700">{isUser ? 'أنت' : company.name}</span>
          <span className="text-[10px] text-ink-400">{relTime(time)}</span>
        </div>
        <div className={cn(
          'rounded-2xl px-4 py-3 text-[14.5px] leading-relaxed whitespace-pre-wrap',
          isUser
            ? 'bg-brand-500 text-white shadow-soft rounded-tl-md'
            : error
              ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200 rounded-tr-md'
              : 'bg-white text-ink-800 ring-1 ring-ink-100 shadow-soft rounded-tr-md',
        )}>
          {content}
        </div>
      </div>
    </div>
  );
}

function Typing({ company }) {
  return (
    <div className="flex gap-2.5 animate-fade-in">
      <Avatar name={company.name} size={32} />
      <div className="bg-white ring-1 ring-ink-100 rounded-2xl rounded-tr-md px-4 py-3.5 flex items-center gap-1.5 shadow-soft">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  );
}
