import { useEffect, useState } from 'react';
import { Plus, Mail, User, Copy, Trash2, Users, Building2, KeyRound } from 'lucide-react';
import { Modal, ConfirmDialog } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { relTime } from '../lib/utils';

const COMPANY_STORAGE_KEY = 'clients.companyId';

export function ClientsPage() {
  const [companies, setCompanies]   = useState([]);
  const [companyId, setCompanyId]   = useState(null);
  const [clients, setClients]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const [newCred, setNewCred]       = useState(null);
  const { push } = useToast();

  // Pick the persisted selection if it still exists; otherwise default to the
  // first company. Without this, navigating away and back resets the dropdown
  // to companies[0] and a previously-selected (empty) company looks like its
  // clients vanished.
  useEffect(() => {
    api.listCompanies()
      .then((cs) => {
        setCompanies(cs);
        const saved = localStorage.getItem(COMPANY_STORAGE_KEY);
        const stillValid = saved && cs.some((c) => c.id === saved);
        if (stillValid)   setCompanyId(saved);
        else if (cs.length) setCompanyId(cs[0].id);
        else                setLoading(false);
      })
      .catch((e) => { push(e.message, 'error'); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!companyId) return;
    localStorage.setItem(COMPANY_STORAGE_KEY, companyId);
    setLoading(true);
    api.listClients(companyId)
      .then(setClients)
      .catch((e) => push(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [companyId]);

  const onCreated = (cred) => {
    setCreateOpen(false);
    setNewCred(cred);
    api.listClients(companyId).then(setClients).catch(() => {});
  };

  const onDelete = async () => {
    if (!confirmDel) return;
    try {
      await api.deleteClient(companyId, confirmDel.id);
      push(`تم حذف ${confirmDel.email}`, 'success');
      setClients((arr) => arr.filter((c) => c.id !== confirmDel.id));
    } catch (e) { push(e.message, 'error'); }
    finally { setConfirmDel(null); }
  };

  const company = companies.find((c) => c.id === companyId);

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto" dir="rtl">
      <header className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-[22px] font-bold text-ink-900 tracking-tight">عملاء الشركة</h1>
          <p className="text-[13px] text-ink-500 mt-1">العملاء الذين تم منحهم حق محادثة المساعد الذكي.</p>
        </div>
        <div className="flex items-center gap-2">
          {companies.length > 1 && (
            <select
              value={companyId || ''}
              onChange={(e) => setCompanyId(e.target.value)}
              className="h-9 rounded-xl border border-ink-200 bg-white px-3 text-[13px] text-ink-800 focus-ring"
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <Button variant="brand" disabled={!companyId} onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" /> عميل جديد
          </Button>
        </div>
      </header>

      {company && (
        <div className="mb-5 flex items-center gap-2 text-[12.5px] text-ink-500 bg-ink-50 border border-ink-100 rounded-xl px-3.5 py-2 w-fit">
          <Building2 className="w-3.5 h-3.5" />
          <span>الشركة:</span>
          <strong className="text-ink-800">{company.name}</strong>
        </div>
      )}

      {!companyId ? (
        <EmptyState
          icon={Building2}
          title="مفيش شركات لسه"
          description="اعمل شركة الأول من تبويب الشركات، وبعدها تقدر تضيف عملاء عليها."
        />
      ) : loading ? (
        <div className="text-center text-ink-400 py-12 text-sm">جاري التحميل…</div>
      ) : clients.length === 0 ? (
        <EmptyState
          icon={Users}
          title="ما عندكش عملاء لسه"
          description="أضف عميل جديد علشان يدخل صفحة الشركة ويكلّم المساعد."
        />
      ) : (
        <div className="bg-white border border-ink-100 rounded-2xl overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-ink-50 text-ink-600 text-[11.5px] uppercase tracking-wider">
              <tr>
                <th className="text-right px-4 py-3 font-semibold">الاسم</th>
                <th className="text-right px-4 py-3 font-semibold">البريد</th>
                <th className="text-right px-4 py-3 font-semibold">آخر دخول</th>
                <th className="text-right px-4 py-3 font-semibold">مضاف منذ</th>
                <th className="text-left px-4 py-3 font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {clients.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50/50 transition-colors">
                  <td className="px-4 py-3 text-ink-800 font-medium">{c.name || '—'}</td>
                  <td className="px-4 py-3 text-ink-700" dir="ltr">{c.email}</td>
                  <td className="px-4 py-3 text-ink-500 text-[12px]">
                    {c.last_login_at ? relTime(c.last_login_at) : <span className="text-ink-400">لم يدخل بعد</span>}
                  </td>
                  <td className="px-4 py-3 text-ink-500 text-[12px]">{relTime(c.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setConfirmDel(c)}
                        className="w-8 h-8 rounded-lg text-ink-500 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition-colors"
                        title="حذف"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateClientModal
        open={createOpen}
        companyId={companyId}
        onClose={() => setCreateOpen(false)}
        onCreated={onCreated}
      />

      <NewCredentialsModal cred={newCred} companyId={companyId} onClose={() => setNewCred(null)} />

      <ConfirmDialog
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        onConfirm={onDelete}
        title="حذف العميل"
        message={`هل تريد حذف ${confirmDel?.email}؟ لن يستطيع الدخول بعد ذلك.`}
        confirmLabel="احذف"
        confirmVariant="danger"
      />
    </div>
  );
}

function CreateClientModal({ open, companyId, onClose, onCreated }) {
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (open) { setName(''); setEmail(''); setError(''); } }, [open]);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const cred = await api.createClient(companyId, { email: email.trim(), name: name.trim() });
      onCreated(cred);
    } catch (e) { setError(e.message); }
    finally     { setBusy(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="عميل جديد"
      description="النظام يولّد كلمة سر تلقائياً، انسخها وابعتها للعميل بأمان."
      size="sm"
      footer={<>
        <Button variant="brand" onClick={submit} loading={busy} disabled={!email || !companyId}>إنشاء الحساب</Button>
        <Button variant="ghost" onClick={onClose}>إلغاء</Button>
      </>}
    >
      <div className="space-y-4">
        <div>
          <Label>اسم العميل</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="أحمد الفلاني"
            leftIcon={<User className="w-3.5 h-3.5" />}
          />
        </div>
        <div>
          <Label>البريد الإلكتروني</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="client@example.com"
            required
            leftIcon={<Mail className="w-3.5 h-3.5" />}
            dir="ltr"
          />
        </div>
        {error && (
          <div className="text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{error}</div>
        )}
      </div>
    </Modal>
  );
}

function NewCredentialsModal({ cred, companyId, onClose }) {
  const { push } = useToast();
  if (!cred) return null;

  const loginLink = `${window.location.origin}/c/${companyId}`;
  const copy = (text, label) => {
    navigator.clipboard.writeText(text).then(
      () => push(`${label} اتنسخ`, 'success'),
      () => push('ما قدرتش أنسخ تلقائياً', 'error'),
    );
  };

  return (
    <Modal
      open={!!cred}
      onClose={onClose}
      title="بيانات الدخول للعميل"
      description="انسخ البيانات وابعتها للعميل — كلمة السر دي ما تتعرضش تاني."
      size="sm"
      footer={<Button variant="primary" onClick={onClose}>تمام</Button>}
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-[12.5px] text-amber-900">
          <KeyRound className="w-3.5 h-3.5 inline ml-1" />
          <strong>مهم:</strong> كلمة السر دي تظهر مرة واحدة فقط. لو ضاعت محتاج تعمل حساب جديد.
        </div>

        <div>
          <Label>الرابط</Label>
          <div className="flex gap-2">
            <Input value={loginLink} readOnly dir="ltr" className="flex-1 bg-ink-50 text-[12.5px] font-mono" />
            <Button variant="secondary" onClick={() => copy(loginLink, 'الرابط')}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        <div>
          <Label>البريد</Label>
          <div className="flex gap-2">
            <Input value={cred.email} readOnly dir="ltr" className="flex-1 bg-ink-50" />
            <Button variant="secondary" onClick={() => copy(cred.email, 'البريد')}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        <div>
          <Label>كلمة السر</Label>
          <div className="flex gap-2">
            <Input value={cred.password} readOnly dir="ltr" className="flex-1 bg-ink-50 font-mono text-[14px]" />
            <Button variant="secondary" onClick={() => copy(cred.password, 'كلمة السر')}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
