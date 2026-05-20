import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Avatar } from '../ui/Avatar';
import { Sparkles, RefreshCw, PhoneCall, MessageSquare, Clock, User, Bot, Mic, Type } from 'lucide-react';
import { fmtDate, fmtDuration, relTime } from '../../lib/utils';

export function SessionDetail({ open, onClose, kind, data, companyName, onResummarize }) {
  const [summarizing, setSummarizing] = useState(false);
  if (!data) return null;

  const handleSummarize = async () => {
    setSummarizing(true);
    try { await onResummarize(); } finally { setSummarizing(false); }
  };

  if (kind === 'call') {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={`مكالمة من ${data.caller_number || 'رقم مجهول'}`}
        description={`${fmtDate(data.started_at)} · ${fmtDuration(data.duration_sec)} · ${data.ended_reason || 'انتهت'}`}
        size="lg"
        footer={<>
          <Button variant="brand" onClick={handleSummarize} loading={summarizing}>
            <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
            {data.summary ? 'إعادة تلخيص' : 'توليد ملخص'}
          </Button>
          <Button variant="ghost" onClick={onClose}>إغلاق</Button>
        </>}
      >
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-3">
            <MetaCard icon={Clock} label="المدة" value={fmtDuration(data.duration_sec)} />
            <MetaCard icon={PhoneCall} label="السبب" value={data.ended_reason || '—'} />
            <MetaCard icon={User} label="من" value={data.caller_number || 'مجهول'} mono />
          </div>

          {data.summary && (
            <div className="rounded-2xl bg-gradient-to-br from-amber-50 to-white border border-amber-200/60 p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded-md bg-amber-500 flex items-center justify-center">
                  <Sparkles className="w-3 h-3 text-white" strokeWidth={2.5} />
                </div>
                <span className="text-[12px] font-semibold text-amber-900 uppercase tracking-wider">ملخص ذكي</span>
              </div>
              <p className="text-[14px] text-ink-800 leading-relaxed">{data.summary}</p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-[13px] font-semibold text-ink-700">النص الكامل</h4>
              <span className="text-[11.5px] text-ink-500">{data.transcript ? `${data.transcript.length} حرف` : 'لا يوجد نص'}</span>
            </div>
            <div className="rounded-xl bg-ink-50/60 ring-1 ring-ink-100 p-4 max-h-[300px] overflow-y-auto">
              <pre className="text-[13px] text-ink-800 leading-relaxed whitespace-pre-wrap font-arabic">
                {data.transcript || '(لا يوجد نص متاح بعد)'}
              </pre>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // Chat session
  const messages = data.messages || [];
  const summary = data.summary || messages[0]?.summary;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`جلسة شات — ${companyName || ''}`}
      description={`${messages.length} رسالة · ${messages[0] ? relTime(messages[0].created_at) : ''}`}
      size="lg"
      footer={<>
        <Button variant="brand" onClick={handleSummarize} loading={summarizing}>
          <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
          {summary ? 'إعادة تلخيص' : 'توليد ملخص'}
        </Button>
        <Button variant="ghost" onClick={onClose}>إغلاق</Button>
      </>}
    >
      <div className="space-y-4">
        {summary && (
          <div className="rounded-2xl bg-gradient-to-br from-brand-50 to-white border border-brand-200/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-md bg-brand-500 flex items-center justify-center">
                <Sparkles className="w-3 h-3 text-white" strokeWidth={2.5} />
              </div>
              <span className="text-[12px] font-semibold text-brand-900 uppercase tracking-wider">ملخص ذكي</span>
            </div>
            <p className="text-[14px] text-ink-800 leading-relaxed">{summary}</p>
          </div>
        )}

        <div className="space-y-3">
          {messages.map((m) => (
            <div key={m.id} className="space-y-2">
              <ChatBubble role="user" content={m.user_message} time={m.created_at} />
              {m.assistant_reply && (
                <ChatBubble role="assistant" content={m.assistant_reply} latencyMs={m.latency_ms} channel={m.channel} time={m.created_at} />
              )}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ChatBubble({ role, content, time, latencyMs, channel }) {
  const isUser = role === 'user';
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${
        isUser ? 'bg-ink-900 text-white' : 'bg-gradient-to-br from-brand-400 to-brand-700 text-white'
      }`}>
        {isUser ? <User className="w-3.5 h-3.5" strokeWidth={2} /> : <Bot className="w-3.5 h-3.5" strokeWidth={2} />}
      </div>
      <div className={`flex-1 min-w-0 ${isUser ? 'pl-12' : 'pr-12'}`}>
        <div className={`flex items-center gap-2 mb-1 ${isUser ? 'flex-row-reverse' : ''}`}>
          <span className="text-[11px] font-semibold text-ink-700">{isUser ? 'العميل' : 'المساعد'}</span>
          <span className="text-[10.5px] text-ink-400">{relTime(time)}</span>
          {!isUser && latencyMs ? <span className="text-[10.5px] text-ink-400 tabular-nums">· {latencyMs}ms</span> : null}
          {!isUser && channel === 'voice' ? (
            <Badge tone="info" className="text-[9.5px] !py-0"><Mic className="w-2.5 h-2.5" /> صوت</Badge>
          ) : !isUser && channel === 'text' ? (
            <Badge tone="neutral" className="text-[9.5px] !py-0"><Type className="w-2.5 h-2.5" /> نص</Badge>
          ) : null}
        </div>
        <div className={`inline-block max-w-full rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed ${
          isUser ? 'bg-ink-100 text-ink-900' : 'bg-white border border-ink-100 text-ink-800'
        }`}>
          {content}
        </div>
      </div>
    </div>
  );
}

function MetaCard({ icon: Icon, label, value, mono }) {
  return (
    <div className="bg-white ring-1 ring-ink-100 rounded-xl p-3">
      <div className="flex items-center gap-1.5 text-[10.5px] text-ink-500 uppercase tracking-wider font-medium">
        <Icon className="w-3 h-3" strokeWidth={2} />
        {label}
      </div>
      <div className={`mt-1 text-[14px] font-semibold text-ink-900 ${mono ? 'font-mono text-[12.5px]' : ''}`}>{value}</div>
    </div>
  );
}
