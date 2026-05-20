import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Loader2, AlertCircle, Volume2, Square } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { cn, relTime } from '../../lib/utils';

// Push-to-talk using Web SpeechRecognition (Chrome/Edge/Safari).
// Transcript is sent to /chat-voice which returns an MP3 stream we play back.
export function VoicePanel({ company }) {
  const [supported, setSupported] = useState(true);
  const [permError, setPermError] = useState(false);
  const [state, setState]         = useState('idle');       // idle | listening | thinking | speaking
  const [transcript, setTranscript] = useState('');
  const [conversation, setConversation] = useState([]);
  const [sessionId]               = useState(`vc-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);

  const recogRef     = useRef(null);
  const audioRef     = useRef(null);
  const finalRef     = useRef('');

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const r = new SR();
    r.lang = 'ar-SA';
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalRef.current += t + ' ';
        else interim += t;
      }
      setTranscript((finalRef.current + interim).trim());
    };
    r.onend = async () => {
      const text = finalRef.current.trim();
      finalRef.current = '';
      if (!text) { setState('idle'); return; }
      await answer(text);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setPermError(true);
      setState('idle');
    };
    recogRef.current = r;
    return () => { try { r.stop(); } catch {} };
  }, []);

  const startListening = () => {
    if (!recogRef.current || state !== 'idle') return;
    setTranscript('');
    finalRef.current = '';
    setState('listening');
    try { recogRef.current.start(); } catch {}
  };

  const stopListening = () => {
    if (state !== 'listening') return;
    try { recogRef.current.stop(); } catch {}
  };

  const answer = async (text) => {
    setConversation((c) => [...c, { role: 'user', content: text, time: new Date().toISOString() }]);
    setState('thinking');
    setTranscript('');
    try {
      const res = await fetch('/chat-voice', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ companyId: company.id, message: text, sessionId,
          history: conversation.map((m) => ({ role: m.role, content: m.content })) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const replyB64 = res.headers.get('x-reply-text') || '';
      const reply = replyB64 ? new TextDecoder('utf-8').decode(Uint8Array.from(atob(replyB64), c => c.charCodeAt(0))) : '';
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      setConversation((c) => [...c, { role: 'assistant', content: reply, time: new Date().toISOString() }]);
      setState('speaking');
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.onended = () => { setState('idle'); URL.revokeObjectURL(url); };
        await audioRef.current.play().catch(() => setState('idle'));
      }
    } catch (e) {
      setConversation((c) => [...c, { role: 'assistant', content: 'عذراً، حصل خطأ.', error: true, time: new Date().toISOString() }]);
      setState('idle');
    }
  };

  const stopSpeaking = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setState('idle');
  };

  if (!supported) {
    return (
      <div className="flex flex-col items-center justify-center text-center px-8 py-16">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h3 className="text-[16px] font-semibold text-ink-900 mb-1.5">المتصفح لا يدعم التحدث الصوتي</h3>
        <p className="text-[13px] text-ink-500 max-w-sm leading-relaxed">
          الميزة دي تشتغل في Chrome أو Edge أو Safari. تقدر تستخدم تبويب "محادثة" أو "اتصال هاتفي" بدلاً عنها.
        </p>
      </div>
    );
  }

  const isBusy = state !== 'idle';

  return (
    <div className="flex flex-col h-full">
      <audio ref={audioRef} className="hidden" />

      {/* ─── Conversation transcript ─── */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-8 py-6">
        {conversation.length === 0 ? (
          <Intro company={company} />
        ) : (
          <div className="max-w-2xl mx-auto space-y-4">
            {conversation.map((m, i) => (
              <Line key={i} role={m.role} content={m.content} time={m.time} company={company} error={m.error} />
            ))}
            {transcript && state === 'listening' && (
              <Line role="user" content={transcript + ' ...'} time={new Date().toISOString()} company={company} interim />
            )}
          </div>
        )}
      </div>

      {/* ─── Mic button + state ─── */}
      <div className="border-t border-ink-100 bg-gradient-to-b from-white to-ink-50/50 px-6 py-6">
        <div className="flex flex-col items-center gap-3">
          <StateLabel state={state} permError={permError} />

          <div className="relative">
            {state === 'listening' && (
              <>
                <span className="absolute inset-0 rounded-full bg-rose-500/20 animate-ping" />
                <span className="absolute -inset-2 rounded-full bg-rose-500/10 animate-pulse" />
              </>
            )}
            {state === 'speaking' && (
              <span className="absolute -inset-2 rounded-full bg-emerald-500/15 animate-pulse" />
            )}

            <button
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onMouseLeave={stopListening}
              onTouchStart={(e) => { e.preventDefault(); startListening(); }}
              onTouchEnd={(e) => { e.preventDefault(); stopListening(); }}
              disabled={state === 'thinking' || state === 'speaking'}
              className={cn(
                'relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 shadow-pop',
                state === 'idle'      && 'bg-ink-900 text-white hover:bg-ink-800 hover:scale-105 active:scale-95',
                state === 'listening' && 'bg-rose-500 text-white scale-110',
                state === 'thinking'  && 'bg-ink-100 text-ink-400 cursor-not-allowed',
                state === 'speaking'  && 'bg-emerald-500 text-white',
              )}
            >
              {state === 'idle'      && <Mic className="w-7 h-7" strokeWidth={2} />}
              {state === 'listening' && <MicOff className="w-7 h-7" strokeWidth={2} />}
              {state === 'thinking'  && <Loader2 className="w-7 h-7 animate-spin" strokeWidth={2} />}
              {state === 'speaking'  && <Volume2 className="w-7 h-7" strokeWidth={2} />}
            </button>
          </div>

          {state === 'speaking' ? (
            <button onClick={stopSpeaking} className="text-[12px] text-ink-500 hover:text-ink-900 flex items-center gap-1.5 transition-colors">
              <Square className="w-3 h-3" /> إيقاف الصوت
            </button>
          ) : (
            <p className="text-[11.5px] text-ink-400 text-center max-w-xs leading-relaxed">
              {state === 'idle'      && 'اضغط مطوّلاً على الميكروفون واتكلم، وفلت لما تخلّص'}
              {state === 'listening' && 'بستمعلك... فلت لما تخلّص كلامك'}
              {state === 'thinking'  && 'يفكّر في الرد...'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StateLabel({ state, permError }) {
  if (permError) {
    return <Badge tone="danger" dot>الميكروفون مرفوض. فعّله من إعدادات المتصفح</Badge>;
  }
  const map = {
    idle      : { tone: 'neutral', text: 'جاهز للاستماع' },
    listening : { tone: 'danger',  text: 'يستمع...' },
    thinking  : { tone: 'info',    text: 'يفكّر' },
    speaking  : { tone: 'success', text: 'يتحدث' },
  };
  const m = map[state];
  return <Badge tone={m.tone} dot className="text-[12px] !py-0.5">{m.text}</Badge>;
}

function Intro({ company }) {
  return (
    <div className="max-w-md mx-auto text-center pt-10">
      <div className="inline-block relative mb-5">
        <Avatar name={company.name} size={64} />
        <div className="absolute -bottom-1 -left-1 w-5 h-5 rounded-full bg-emerald-500 ring-4 ring-white" />
      </div>
      <h2 className="text-[20px] font-bold text-ink-900 tracking-tight">تحدث مع {company.name}</h2>
      <p className="mt-2 text-[14px] text-ink-500 leading-relaxed">
        اضغط على الميكروفون مطوّلاً، اسأل سؤالك بصوتك، وفلت لما تخلّص. هترد عليك بالصوت السعودي مباشرة.
      </p>
      <div className="mt-6 inline-flex items-center gap-2 px-3 py-1.5 bg-ink-100 rounded-full text-[11px] text-ink-600">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        اللهجة سعودية · صوت طبيعي
      </div>
    </div>
  );
}

function Line({ role, content, time, company, error, interim }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex gap-2.5 animate-slide-up', isUser && 'flex-row-reverse')}>
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-7 h-7 rounded-lg bg-ink-200 text-ink-700 text-[11px] font-bold flex items-center justify-center">
            أنت
          </div>
        ) : (
          <Avatar name={company.name} size={28} />
        )}
      </div>
      <div className={cn('flex-1 min-w-0 max-w-[85%]', isUser ? 'pl-6' : 'pr-6')}>
        <div className={cn('flex items-center gap-2 mb-1 px-1', isUser && 'flex-row-reverse')}>
          <span className="text-[11px] font-semibold text-ink-700">{isUser ? 'أنت' : company.name}</span>
          <span className="text-[10px] text-ink-400">{relTime(time)}</span>
        </div>
        <div className={cn(
          'rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed',
          isUser
            ? 'bg-brand-500 text-white rounded-tl-md'
            : error
              ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200 rounded-tr-md'
              : 'bg-white text-ink-800 ring-1 ring-ink-100 rounded-tr-md',
          interim && 'opacity-60 italic',
        )}>
          {content}
        </div>
      </div>
    </div>
  );
}
