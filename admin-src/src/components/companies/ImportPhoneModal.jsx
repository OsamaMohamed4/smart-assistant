import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Input, Label } from '../ui/Input';
import { Button } from '../ui/Button';
import { PhoneIncoming, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';

// Register a company's EXISTING 3CX number with the voice provider.
//
// This existed as an HTTP route and a CLI script for a long time with no way to
// reach it from the dashboard, which meant the one step between "published
// agent" and "the phone rings" required a terminal, the production
// DATABASE_URL, and knowing the flags. That is why companies kept reaching the
// Playground and failing with NO_PHONE_NUMBER_ID.
//
// No number is ever PURCHASED here. `phoneNumber` is the DID the company
// already owns and advertises; `address` points back at their own PBX, so the
// provider is only ever told how to reach a line that is already theirs.
export function ImportPhoneModal({ open, onClose, company, push, onDone }) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [address, setAddress]         = useState('');
  const [transport, setTransport]     = useState('udp');
  const [allowlist, setAllowlist]     = useState('');
  const [username, setUsername]       = useState('');
  const [password, setPassword]       = useState('');
  const [saving, setSaving]           = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhoneNumber(company?.phoneNumber || '');
    // The PBX address is infrastructure, not per-company: prefilling the last
    // one used saves retyping it for every company on the same trunk.
    setAddress(localStorage.getItem('sip:lastAddress') || '');
    setAllowlist(localStorage.getItem('sip:lastAllowlist') || '');
    setTransport(localStorage.getItem('sip:lastTransport') || 'udp');
    setUsername(''); setPassword('');
  }, [open, company]);

  const phoneOk = /^\+[1-9]\d{7,14}$/.test(phoneNumber.trim());
  // A bare host or IP. The provider rejects a sip: URI, and catching it here
  // gives a usable message instead of a 502 from upstream.
  const addressOk = address.trim().length > 0
    && !/^sips?:/i.test(address.trim())
    && !/\s/.test(address.trim());

  const submit = async () => {
    setSaving(true);
    try {
      const r = await api.importPhone(company.id, {
        phoneNumber: phoneNumber.trim(),
        address    : address.trim(),
        transport,
        allowedAddresses: allowlist.split(',').map((x) => x.trim()).filter(Boolean),
        ...(username.trim() ? { username: username.trim(), password } : {}),
      });
      localStorage.setItem('sip:lastAddress', address.trim());
      localStorage.setItem('sip:lastAllowlist', allowlist.trim());
      localStorage.setItem('sip:lastTransport', transport);

      // Importing only registers the line. Until it is bound, an incoming call
      // reaches the provider and finds no agent to answer it, so do both here
      // rather than leaving a half-finished state behind a second button.
      try {
        await api.bindPhone(company.id);
        push(`تم استيراد ${r.phoneNumber} وربطه بالوكيل`, 'success');
      } catch {
        push(`تم استيراد ${r.phoneNumber} — لكن الربط بالوكيل فشل. انشر الشركة ثم اضغط «اربط الرقم».`, 'error');
      }

      if (r.releasedFrom?.length) {
        push(`ملاحظة: الرقم كان مسجّلاً على ${r.releasedFrom.join('، ')} وتم نقله`, 'info');
      }
      onDone?.();
      onClose();
    } catch (e) {
      push(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!company) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`استيراد رقم ${company.name}`}
      description="تسجيل رقم الشركة الحالي على 3CX لدى مزوّد الصوت. لا يتم شراء أي رقم."
      size="md"
      footer={<>
        <Button variant="brand" onClick={submit} loading={saving} disabled={!phoneOk || !addressOk}>
          <PhoneIncoming className="w-3.5 h-3.5" strokeWidth={2} />
          استيراد وربط
        </Button>
        <Button variant="ghost" onClick={onClose}>إلغاء</Button>
      </>}
    >
      <div className="space-y-5">
        {!company.agentId && (
          <div className="flex gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" strokeWidth={2} />
            <p className="text-[12px] text-amber-900 leading-relaxed">
              هذه الشركة غير منشورة بعد، فلا يوجد وكيل يردّ على الرقم.
              سيُستورد الرقم وسيفشل الربط — انشر الشركة أولاً.
            </p>
          </div>
        )}

        <div>
          <Label>رقم الشركة على 3CX</Label>
          <Input
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+966XXXXXXXXX"
            dir="ltr"
          />
          <p className="mt-1 text-[11px] text-ink-500 leading-relaxed">
            الرقم الذي تملكه الشركة بالفعل، بصيغة دولية تبدأ بـ +. لا يتم شراء رقم جديد.
            {phoneNumber && !phoneOk && (
              <span className="block text-rose-600 mt-0.5">الصيغة غير صحيحة — مثال: ‎+966115110149</span>
            )}
          </p>
        </div>

        <div>
          <Label>عنوان بدّالة 3CX</Label>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="pbx.example.com أو 203.0.113.10"
            dir="ltr"
          />
          <p className="mt-1 text-[11px] text-ink-500 leading-relaxed">
            اسم النطاق أو الـ IP فقط — بدون <code className="font-mono">sip:</code> وبدون مسافات.
            اسأل مسؤول الشبكة عنه إن لم يكن لديك.
            {address && !addressOk && (
              <span className="block text-rose-600 mt-0.5">يجب أن يكون اسم نطاق أو IP فقط</span>
            )}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>نوع الاتصال</Label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
              className="w-full h-10 px-3 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring"
              dir="ltr"
            >
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
              <option value="tls">TLS</option>
            </select>
          </div>
          <div>
            <Label>عناوين مسموح بها</Label>
            <Input
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
              placeholder="203.0.113.10"
              dir="ltr"
            />
          </div>
        </div>
        <p className="-mt-2 text-[11px] text-ink-500 leading-relaxed">
          العناوين المسموح بها هي الـ IP الذي تتصل منه البدّالة — عادةً نفس عنوانها أعلاه.
          بدونها وبدون بيانات دخول، سيرفض المزوّد المكالمات الواردة.
        </p>

        <details className="group">
          <summary className="text-[12px] text-ink-600 cursor-pointer select-none hover:text-ink-900">
            بيانات دخول SIP (اختياري)
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <Label>اسم المستخدم</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} dir="ltr" autoComplete="off" />
            </div>
            <div>
              <Label>كلمة المرور</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" autoComplete="new-password" />
            </div>
          </div>
          <p className="mt-2 text-[11px] text-ink-500 leading-relaxed">
            اتركهما فارغين إذا كان الربط يعتمد على عنوان الـ IP فقط.
            بيانات الدخول أفضل عندما يكون عنوان البدّالة متغيّراً، لأن القائمة المسموح بها
            تتوقف عن العمل في اليوم الذي يتغيّر فيه العنوان.
          </p>
        </details>
      </div>
    </Modal>
  );
}
