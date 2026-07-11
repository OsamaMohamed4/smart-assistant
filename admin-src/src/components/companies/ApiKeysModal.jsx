import { useState, useEffect, useCallback } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Key, Plus, Copy, Check, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { relTime } from '../../lib/utils';

// Per-company API keys for the public Agent API. The plaintext key is shown
// exactly once (server stores only its hash) — the copy banner is the user's
// single chance to save it.
export function ApiKeysModal({ open, onClose, company, push }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [freshKey, setFreshKey] = useState(null); // { key, name } shown once
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    if (!company) return;
    setLoading(true);
    api.listApiKeys(company.id)
      .then(setKeys)
      .catch((e) => push(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [company, push]);

  useEffect(() => {
    if (open) { setFreshKey(null); setName(''); load(); }
  }, [open, load]);

  const create = async () => {
    setCreating(true);
    try {
      const r = await api.createApiKey(company.id, name.trim() || 'default');
      setFreshKey(r);
      load();
    } catch (e) { push(e.message, 'error'); }
    finally { setCreating(false); }
  };

  const revoke = async (keyId) => {
    try {
      await api.revokeApiKey(company.id, keyId);
      push('تم إلغاء المفتاح', 'success');
      load();
    } catch (e) { push(e.message, 'error'); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(freshKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { push('انسخ المفتاح يدوياً', 'error'); }
  };

  if (!company) return null;
  return (
    <Modal open={open} onClose={onClose} title={`مفاتيح API — ${company.name}`}
      description="للتكاملات الخارجية عبر ‎/api/v1/agent/chat‎ — كل مفتاح مقيّد بهذه الشركة فقط."
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>إغلاق</Button>}>
      <div className="space-y-4">
        {freshKey && (
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4">
            <div className="text-[12.5px] font-semibold text-emerald-900 mb-1">
              انسخ المفتاح الآن — لن يظهر مرة أخرى بعد إغلاق النافذة
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[12px] font-mono bg-white rounded-lg px-3 py-2 ring-1 ring-emerald-200 break-all select-all" dir="ltr">
                {freshKey.key}
              </code>
              <Button variant="brand" size="sm" onClick={copy} className="gap-1.5 shrink-0">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'تم النسخ' : 'نسخ'}
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسم المفتاح (مثلاً: LoopChat)"
            className="flex-1 h-10 px-3 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring"
          />
          <Button variant="brand" onClick={create} loading={creating} className="gap-1.5 shrink-0">
            <Plus className="w-3.5 h-3.5" /> مفتاح جديد
          </Button>
        </div>

        <div className="space-y-2">
          {loading && <div className="text-[13px] text-ink-500 py-4 text-center">جارِ التحميل…</div>}
          {!loading && keys.length === 0 && (
            <div className="text-[13px] text-ink-500 py-6 text-center">لا توجد مفاتيح بعد — أنشئ أول مفتاح للتكامل الخارجي.</div>
          )}
          {keys.map((k) => (
            <div key={k.id} className={`flex items-center gap-3 rounded-xl ring-1 ring-ink-100 p-3 ${k.revoked_at ? 'bg-ink-50/60 opacity-60' : 'bg-white'}`}>
              <div className="w-8 h-8 rounded-lg bg-ink-100 flex items-center justify-center shrink-0">
                <Key className="w-4 h-4 text-ink-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink-900 truncate">{k.name || 'default'}</span>
                  {k.revoked_at
                    ? <Badge tone="neutral">مُلغى</Badge>
                    : <Badge tone="success" dot>نشط</Badge>}
                </div>
                <div className="text-[11px] font-mono text-ink-500" dir="ltr">
                  {k.prefix}…&nbsp;&nbsp;
                  {k.last_used_at ? `آخر استخدام ${relTime(k.last_used_at)}` : 'لم يُستخدم بعد'}
                </div>
              </div>
              {!k.revoked_at && (
                <button onClick={() => revoke(k.id)}
                  className="w-8 h-8 rounded-lg text-rose-500 hover:bg-rose-50 flex items-center justify-center transition-colors shrink-0"
                  title="إلغاء المفتاح">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
