import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, CheckCircle2, AlertTriangle, User as UserIcon, Volume2,
  Phone, Settings2, MessageSquare, Mic, Send, Loader2, RotateCcw,
  ArrowUpRight, Hash,
} from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Badge } from '../components/ui/Badge';
import { Avatar } from '../components/ui/Avatar';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Label } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn, relTime } from '../lib/utils';

// Playground = sarj-style test bench for the synced Vapi assistant.
//
// Two modes:
//   voice → fill phone number + "Start Call" → Vapi rings the user's phone.
//           Uses the company's assistantId with assistantOverrides for the
//           variable values. No WebRTC in the browser at all.
//   chat  → text exchange via Vapi's /chat endpoint. Same assistant, same
//           prompt, same variables — just no audio.
//
// Both modes run the EXACT same Vapi assistant. What you test here is what
// callers will get on the phone for real.
const GLOBAL_VARS = new Set(['agent_name', 'date', 'time']);

export function PlaygroundPage({ pinnedCompanyId }) {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(pinnedCompanyId || null);
  const [voices, setVoices]       = useState([]);
  const [voiceId, setVoiceId]     = useState(null);
  const [scenario, setScenario]   = useState(null);
  const [scenLoading, setScenLoading] = useState(true);

  const [mode, setMode]   = useState('voice');     // voice | chat
  const [vars, setVars]   = useState({});
  const [phone, setPhone] = useState('+966');
  const [calling, setCalling] = useState(false);

  // Chat state
  const [chatId, setChatId]       = useState(null);
  // Stable id for the whole Playground conversation so the backend groups
  // every turn into one row on the Conversations page. Regenerated on reset.
  const [sessionId, setSessionId] = useState(() => 'pg-' + crypto.randomUUID());
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [chatBusy, setChatBusy]   = useState(false);
  const chatScrollRef = useRef(null);

  // ─── Bootstrap ──────────────────────────────────────────
  useEffect(() => {
    api.listVoices().then((v) => {
      setVoices(v);
      if (v[0]) setVoiceId(v[0].id);
    }).catch((e) => push(e.message, 'error'));

    api.listCompanies().then((cs) => {
      const scoped = pinnedCompanyId ? cs.filter((c) => c.id === pinnedCompanyId) : cs;
      setCompanies(scoped);
      setCompanyId((curr) => curr || scoped[0]?.id || null);
    }).catch((e) => push(e.message, 'error'));
  }, [pinnedCompanyId]);

  useEffect(() => {
    if (!companyId) return;
    setScenLoading(true);
    setScenario(null);
    api.activeScenario(companyId)
      .then((s) => {
        setScenario(s);
        if (s?.variables?.length) {
          const initial = {};
          for (const v of s.variables) if (!GLOBAL_VARS.has(v.name)) initial[v.name] = '';
          setVars(initial);
        } else {
          setVars({});
        }
        // Reset chat session when switching company.
        setChatId(null); setMessages([]); setSessionId('pg-' + crypto.randomUUID());
      })
      .catch((e) => push(e.message, 'error'))
      .finally(() => setScenLoading(false));
  }, [companyId]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, chatBusy]);

  const activeCompany = companies.find((c) => c.id === companyId);
  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === voiceId) || null,
    [voices, voiceId],
  );
  const agentName = selectedVoice?.label || selectedVoice?.name || 'المساعد';

  const userVars = useMemo(() => {
    if (!scenario?.variables) return [];
    return scenario.variables.filter((v) => !GLOBAL_VARS.has(v.name));
  }, [scenario]);
  const missingRequired = userVars.some((v) => v.required && !vars[v.name]?.trim());
  const runtimeVars     = useMemo(
    () => ({ ...vars, agent_name: agentName }),
    [vars, agentName],
  );

  const published = !!activeCompany?.assistantId;
  const phoneOk   = /^\+[1-9]\d{7,14}$/.test(phone.trim());
  const canCall   = published && phoneOk && !missingRequired && !calling && !!scenario;
  const scenarioOutOfSync = scenario && activeCompany?.lastSyncedAt
    && new Date(scenario.updatedAt) > new Date(activeCompany.lastSyncedAt);

  // ─── Voice mode: outbound call ─────────────────────────
  const startCall = async () => {
    if (!canCall) return;
    setCalling(true);
    try {
      await api.outboundCall(companyId, {
        phoneNumber   : phone.trim(),
        variableValues: runtimeVars,
      });
      push(`جارٍ الاتصال بـ ${phone.trim()}`, 'success');
    } catch (e) {
      push(e.message, 'error');
    } finally {
      setCalling(false);
    }
  };

  // ─── Chat mode ─────────────────────────────────────────
  const sendChat = async (text) => {
    const msg = text.trim();
    if (!msg || !published || chatBusy) return;
    if (missingRequired) { push('عبّ الحقول المطلوبة', 'error'); return; }
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: msg, time: new Date().toISOString() }]);
    setChatBusy(true);
    try {
      const r = await api.assistantChat(companyId, {
        message       : msg,
        previousChatId: chatId,
        sessionId,
        variableValues: runtimeVars,
      });
      setChatId(r.chatId);
      setMessages((m) => [...m, {
        role: 'assistant', content: r.reply, time: new Date().toISOString(),
      }]);
    } catch (e) {
      setMessages((m) => [...m, {
        role: 'assistant', content: e.message, error: true, time: new Date().toISOString(),
      }]);
      push(e.message, 'error');
    } finally {
      setChatBusy(false);
    }
  };
  const resetChat = () => { setChatId(null); setMessages([]); setSessionId('pg-' + crypto.randomUUID()); };

  // ─── Render ─────────────────────────────────────────────
  if (!companyId) {
    return (
      <div className="p-10">
        <EmptyState icon={Sparkles} title="لا توجد شركات"
          description="أنشئ شركة من تبويب الشركات أولاً." />
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row lg:h-screen lg:overflow-hidden bg-ink-50/40">
      {/* ═══ Main area ═══════════════════════════ */}
      {/* min-h-0 is required at every flex-column ancestor of the chat scroll
          area; without it Flexbox uses the children's intrinsic height and
          overflow-y-auto on the chat panel never fires. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <TopBar
          title="التجربة"
          subtitle={
            scenario
              ? `${scenario.name} · ${activeCompany?.name || ''}`
              : (scenLoading ? 'جارٍ التحميل...' : (activeCompany?.name || ''))
          }
          right={
            <div className="flex items-center gap-2">
              <Badge tone={published ? 'success' : 'warning'} dot>
                Vapi · {published ? 'منشور' : 'غير منشور'}
              </Badge>
              {/* Mode toggle */}
              <div className="flex items-center gap-1 bg-ink-100/80 border border-ink-200 rounded-xl p-0.5">
                {[
                  { id: 'voice', label: 'اتصال', icon: Phone },
                  { id: 'chat',  label: 'شات',   icon: MessageSquare },
                ].map((m) => {
                  const Icon = m.icon;
                  const active = mode === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        'h-8 px-3 rounded-lg text-[12.5px] font-medium flex items-center gap-1.5 transition-colors',
                        active ? 'bg-white text-ink-900 shadow-soft ring-1 ring-ink-100' : 'text-ink-600 hover:text-ink-900',
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          }
        />

        {!scenLoading && !scenario && (
          <div className="flex-1 flex items-center justify-center p-10">
            <EmptyState
              icon={Settings2}
              title="لا يوجد سيناريو نشط"
              description="فعّل سيناريو من تبويب السيناريوهات."
            />
          </div>
        )}

        {scenario && !published && (
          <div className="flex-1 flex items-center justify-center p-10">
            <EmptyState
              icon={AlertTriangle}
              title="الشركة غير منشورة"
              description="انشر الشركة من تبويب الشركات أولاً."
            />
          </div>
        )}

        {scenario && published && (
          <div className="flex-1 flex flex-col min-h-0">
            {scenarioOutOfSync && (
              <div className="mx-8 mt-5 inline-flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[12.5px] text-amber-900">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>السيناريو عُدّل بعد آخر نشر. اضغط <strong>نشر</strong> لتحديث الوكيل.</span>
              </div>
            )}

            {mode === 'voice' && (
              <VoiceModePanel
                phone={phone} setPhone={setPhone}
                phoneOk={phoneOk}
                missingRequired={missingRequired}
                calling={calling}
                onCall={startCall}
                canCall={canCall}
              />
            )}

            {mode === 'chat' && (
              <ChatModePanel
                messages={messages}
                input={input} setInput={setInput}
                onSend={() => sendChat(input)}
                busy={chatBusy}
                company={activeCompany}
                onReset={resetChat}
                scrollRef={chatScrollRef}
                missingRequired={missingRequired}
              />
            )}
          </div>
        )}
      </div>

      {/* ═══ Right pane: data + voice + scenario card ═══ */}
      <div className="w-full lg:w-[340px] lg:shrink-0 border-t lg:border-t-0 lg:border-l border-ink-100 bg-white flex flex-col lg:h-screen overflow-y-auto">
        {companies.length > 1 && (
          <div className="px-4 py-4 border-b border-ink-100">
            <Label>الشركة</Label>
            <select
              value={companyId || ''}
              onChange={(e) => { setCompanyId(e.target.value); resetChat(); }}
              className="w-full h-10 px-3 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring focus:border-ink-300"
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {scenario && userVars.length > 0 && (
          <div className="px-4 py-4 border-b border-ink-100">
            <div className="flex items-center gap-2 mb-3">
              <Settings2 className="w-3.5 h-3.5 text-ink-500" />
              <span className="text-[12px] font-semibold text-ink-900 uppercase tracking-wider">بيانات الإدخال</span>
            </div>
            <div className="space-y-3">
              {userVars.map((v) => (
                <div key={v.name}>
                  <Label>
                    {humanLabel(v.name)}
                    {v.required && <span className="text-rose-500 mr-1">*</span>}
                  </Label>
                  <Input
                    value={vars[v.name] || ''}
                    onChange={(e) => setVars((s) => ({ ...s, [v.name]: e.target.value }))}
                    placeholder={v.name}
                    dir="auto"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="px-4 py-4 border-b border-ink-100">
          <div className="flex items-center gap-2 mb-3">
            <Volume2 className="w-3.5 h-3.5 text-ink-500" />
            <span className="text-[12px] font-semibold text-ink-900 uppercase tracking-wider">صوت الـ Agent</span>
          </div>
          <p className="text-[11px] text-ink-500 mb-3 leading-relaxed">
            اسم الصوت الذي تختاره يُستخدم كاسم الوكيل في المحادثة.
          </p>
          <div className="space-y-2">
            {voices.map((v) => {
              const active = voiceId === v.id;
              return (
                <button
                  key={v.id}
                  onClick={() => setVoiceId(v.id)}
                  className={cn(
                    'w-full text-right p-3 rounded-xl border transition-all',
                    active ? 'border-brand-400 bg-brand-50/60 shadow-soft' : 'border-ink-200 hover:border-ink-300 bg-white',
                  )}>
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                      active ? 'bg-gradient-to-br from-brand-400 to-accent-violet text-white' : 'bg-ink-100 text-ink-600',
                    )}>
                      <span className="text-[14px] font-bold">{v.label?.[0] || v.name?.[0]}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13.5px] font-semibold text-ink-900 truncate">{v.label || v.name}</span>
                        {active && <CheckCircle2 className="w-3.5 h-3.5 text-brand-600 shrink-0" />}
                      </div>
                      <div className="text-[11px] text-ink-500 mt-0.5 truncate">{v.description}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 p-4">
          {scenario && (
            <div className="bg-ink-50/60 border border-ink-100 rounded-xl p-3">
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-ink-500 mb-1.5">السيناريو النشط</div>
              <p className="text-[12.5px] text-ink-800 leading-relaxed font-medium">{scenario.name}</p>
              {scenario.firstMessage && (
                <p className="mt-2 text-[11.5px] text-ink-500 leading-relaxed line-clamp-3">
                  «{scenario.firstMessage}»
                </p>
              )}
              {activeCompany?.assistantId && (
                <a
                  href={`https://dashboard.vapi.ai/assistants/${activeCompany.assistantId}`}
                  target="_blank" rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-brand-700 hover:text-brand-900"
                >
                  افتح في Vapi <ArrowUpRight className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Voice mode: phone number + Start Call ──────────────────────

function VoiceModePanel({ phone, setPhone, phoneOk, missingRequired, calling, onCall, canCall }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-400 to-accent-violet items-center justify-center shadow-pop mb-5">
          <Phone className="w-7 h-7 text-white" strokeWidth={2} />
        </div>
        <h2 className="text-[22px] font-bold text-ink-900 tracking-tight">جرّب الوكيل على جوّالك</h2>
        <p className="mt-2 text-[13.5px] text-ink-500 leading-relaxed">
          اكتب رقمك ليتصل بك الوكيل.
        </p>

        <div className="mt-7 text-right">
          <Label>رقم الجوال</Label>
          <div className="relative">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+966512345678"
              dir="ltr"
              leftIcon={<Hash className="w-3.5 h-3.5" />}
              className="!h-12 !text-[15px] font-mono"
            />
          </div>
          <div className={cn('mt-2 text-[11.5px]',
            phone.trim() === '+966' || !phone ? 'text-ink-400'
              : phoneOk ? 'text-emerald-600' : 'text-rose-500')}>
            {phoneOk ? '✓ صحيح' :
              (phone.trim() === '+966' || !phone) ? 'مثال: +9665XXXXXXXX'
                : 'صيغة غير صحيحة'}
          </div>
        </div>

        {missingRequired && (
          <div className="mt-4 inline-flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-[12px] text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5" />
            عبّ الحقول المطلوبة
          </div>
        )}

        <button
          onClick={onCall}
          disabled={!canCall}
          className={cn(
            'mt-7 w-full h-14 rounded-2xl flex items-center justify-center gap-2.5 font-semibold text-[15px] shadow-pop transition-all',
            canCall
              ? 'bg-gradient-to-br from-brand-500 to-accent-violet text-white hover:-translate-y-0.5'
              : 'bg-ink-200 text-ink-400 cursor-not-allowed',
          )}>
          {calling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
          {calling ? 'جارٍ الاتصال...' : 'ابدأ المكالمة'}
        </button>
      </div>
    </div>
  );
}

// ─── Chat mode ────────────────────────────────────────────────

function ChatModePanel({ messages, input, setInput, onSend, busy, company, onReset, scrollRef, missingRequired }) {
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  };
  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6">
        {messages.length === 0 ? (
          <div className="max-w-2xl mx-auto pt-16 text-center">
            <Avatar name={company?.name || 'AI'} size={56} className="mx-auto" />
            <h2 className="mt-5 text-[20px] font-bold text-ink-900">شات مع {company?.name}</h2>
            <p className="mt-2 text-[13.5px] text-ink-500 max-w-md mx-auto leading-relaxed">
              نفس الوكيل بنفس السيناريو، ردود نصية.
            </p>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-4">
            {messages.map((m, i) => <ChatMessage key={i} {...m} company={company} />)}
            {busy && (
              <div className="flex gap-3">
                <Avatar name={company?.name || 'AI'} size={32} />
                <div className="bg-white ring-1 ring-ink-100 rounded-2xl px-4 py-3.5 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" />
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-400 animate-pulse" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-ink-100 bg-white px-8 py-4">
        <div className="max-w-2xl mx-auto">
          {messages.length > 0 && (
            <div className="flex items-center justify-end mb-2">
              <button onClick={onReset} className="text-[11.5px] text-ink-500 hover:text-ink-800 flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> جلسة جديدة
              </button>
            </div>
          )}
          <div className="relative bg-white border border-ink-200 rounded-2xl shadow-soft focus-within:border-ink-400 focus-within:shadow-glow transition-all">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              placeholder={missingRequired ? 'عبّ الحقول المطلوبة...' : 'اكتب رسالتك...'}
              disabled={busy || missingRequired}
              className="w-full resize-none bg-transparent rounded-2xl px-4 py-3.5 pl-14 text-[14px] placeholder:text-ink-400 outline-none font-arabic leading-relaxed max-h-40 disabled:opacity-50"
              style={{ minHeight: 50 }}
            />
            <button
              onClick={onSend}
              disabled={!input.trim() || busy || missingRequired}
              className={cn(
                'absolute left-2 bottom-2 w-9 h-9 rounded-xl flex items-center justify-center transition-all',
                input.trim() && !busy && !missingRequired
                  ? 'bg-ink-900 text-white hover:bg-ink-800 shadow-soft'
                  : 'bg-ink-100 text-ink-400 cursor-not-allowed',
              )}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" strokeWidth={2.5} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ChatMessage({ role, content, time, error, company }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-8 h-8 rounded-xl bg-ink-900 text-white flex items-center justify-center">
            <UserIcon className="w-3.5 h-3.5" />
          </div>
        ) : (
          <Avatar name={company?.name || 'AI'} size={32} />
        )}
      </div>
      <div className={cn('flex-1 min-w-0', isUser ? 'pl-12' : 'pr-12')}>
        <div className={cn('flex items-center gap-2 mb-1', isUser && 'flex-row-reverse')}>
          <span className="text-[12px] font-semibold text-ink-700">{isUser ? 'أنت' : (company?.name || 'المساعد')}</span>
          <span className="text-[10.5px] text-ink-400">{relTime(time)}</span>
        </div>
        <div className={cn(
          'inline-block max-w-full rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed whitespace-pre-wrap',
          isUser ? 'bg-ink-900 text-white'
            : error ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200'
              : 'bg-white text-ink-800 ring-1 ring-ink-100 shadow-soft',
        )}>
          {content}
        </div>
      </div>
    </div>
  );
}

function humanLabel(name) {
  if (/[؀-ۿ]/.test(name)) return name;
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
