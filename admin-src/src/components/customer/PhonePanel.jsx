import { Phone, PhoneIncoming, Clock, Headphones, Copy, Check } from 'lucide-react';
import { useState } from 'react';

export function PhonePanel({ company }) {
  const [copied, setCopied] = useState(false);
  const phone = company.phoneNumber;

  const copy = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  if (!phone) {
    return (
      <div className="flex flex-col items-center justify-center text-center px-8 py-16">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4">
          <Phone className="w-6 h-6" />
        </div>
        <h3 className="text-[16px] font-semibold text-ink-900 mb-1.5">الاتصال الهاتفي غير متاح حالياً</h3>
        <p className="text-[13px] text-ink-500 max-w-sm leading-relaxed">
          ما تم ربط رقم تليفون بهذه الشركة بعد. استخدم تبويب "محادثة" أو "صوت" للتواصل مع المساعد.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center px-6 py-10 sm:py-14">
      {/* ─── Decorative phone visual ─── */}
      <div className="relative mb-8">
        <span className="absolute -inset-8 rounded-full bg-emerald-500/5 blur-2xl" />
        <span className="absolute -inset-4 rounded-full bg-emerald-500/10 animate-pulse-slow" />
        <div className="relative w-24 h-24 rounded-3xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-pop">
          <Phone className="w-10 h-10 text-white" strokeWidth={1.8} />
        </div>
      </div>

      <h2 className="text-[22px] font-bold text-ink-900 tracking-tight">اتصل بنا الآن</h2>
      <p className="mt-2 text-[14px] text-ink-500 max-w-sm text-center leading-relaxed">
        تكلم مع المساعد الذكي مباشرة عبر التليفون. متاح 24 ساعة في اليوم بدون انتظار.
      </p>

      {/* ─── Phone number card ─── */}
      <div className="mt-8 w-full max-w-md">
        <div className="bg-white border border-ink-100 rounded-2xl p-5 shadow-card">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-500 mb-2">الرقم</div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[24px] font-bold text-ink-900 tabular-nums tracking-tight ltr-num" dir="ltr">{phone}</div>
            <button
              onClick={copy}
              className="shrink-0 w-9 h-9 rounded-lg border border-ink-200 hover:border-ink-400 hover:bg-ink-50 flex items-center justify-center text-ink-600 transition-colors focus-ring"
              aria-label="نسخ الرقم"
            >
              {copied
                ? <Check className="w-4 h-4 text-emerald-600" strokeWidth={2.5} />
                : <Copy className="w-3.5 h-3.5" strokeWidth={2} />}
            </button>
          </div>
        </div>

        <a
          href={`tel:${phone}`}
          className="mt-3 w-full bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl h-14 flex items-center justify-center gap-2.5 font-semibold text-[15px] shadow-soft transition-colors focus-ring"
        >
          <PhoneIncoming className="w-4.5 h-4.5" strokeWidth={2.2} />
          اضغط للاتصال
        </a>

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <InfoCard icon={Clock}      title="متاح 24/7"      desc="بدون انتظار" />
          <InfoCard icon={Headphones} title="صوت طبيعي"      desc="لهجة سعودية" />
        </div>
      </div>

      <p className="mt-8 text-[11px] text-ink-400 text-center max-w-sm">
        قد تطبّق رسوم الاتصال الدولي حسب باقتك لأن الرقم أمريكي. للوصول لرقم محلي تواصل مع الفريق.
      </p>
    </div>
  );
}

function InfoCard({ icon: Icon, title, desc }) {
  return (
    <div className="bg-white border border-ink-100 rounded-xl p-3 flex items-start gap-2.5">
      <div className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5" strokeWidth={2} />
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-ink-900 leading-tight">{title}</div>
        <div className="text-[11px] text-ink-500 mt-0.5">{desc}</div>
      </div>
    </div>
  );
}
