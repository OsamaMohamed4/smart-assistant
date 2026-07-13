import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { relTime } from '../lib/utils';

// The audit_events table has been populated since day one — this page
// finally makes it visible. Superadmin only.
const ACTION_FILTERS = [
  { v: '',          l: 'كل العمليات' },
  { v: 'company.',  l: 'الشركات' },
  { v: 'campaign.', l: 'الحملات' },
  { v: 'apikey.',   l: 'مفاتيح API' },
  { v: 'client.',   l: 'حسابات العملاء' },
  { v: 'document.', l: 'المستندات' },
  { v: 'eval.',     l: 'اختبارات الجودة' },
  { v: 'admin.',    l: 'إدارية' },
];

const TONE_BY_PREFIX = [
  ['delete', 'danger'], ['revoke', 'danger'], ['cancel', 'warning'],
  ['create', 'success'], ['start', 'success'],
];

function actionTone(action) {
  for (const [k, tone] of TONE_BY_PREFIX) if (action.includes(k)) return tone;
  return 'neutral';
}

export function AuditPage() {
  const { push } = useToast();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    api.listAudit(200, filter).then(setRows).catch((e) => push(e.message, 'error'));
  }, [filter, push]);

  useEffect(() => { setRows(null); load(); }, [load]);

  return (
    <div>
      <TopBar
        title="سجل العمليات"
        subtitle="كل عملية إدارية على المنصة: من عملها، على ماذا، ومتى."
        right={<>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring">
            {ACTION_FILTERS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
          </select>
          <Button variant="secondary" size="md" onClick={load} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> تحديث
          </Button>
        </>}
      />

      <div className="px-8 py-7 max-w-4xl">
        {rows && rows.length === 0 && (
          <EmptyState icon={ShieldCheck} title="لا توجد عمليات مطابقة" description="جرّب فلتراً آخر." />
        )}
        <div className="space-y-1.5">
          {(rows || []).map((r) => {
            let meta = null;
            try { meta = r.metadata ? JSON.stringify(JSON.parse(r.metadata)) : null; } catch { meta = r.metadata; }
            return (
              <div key={r.id} className="flex items-center gap-3 bg-white ring-1 ring-ink-100 rounded-xl px-4 py-2.5">
                <Badge tone={actionTone(r.action)}>{r.action}</Badge>
                <span className="text-[12.5px] text-ink-700 truncate font-mono" dir="ltr">{r.resource || '—'}</span>
                <span className="flex-1" />
                {meta && <span className="text-[11px] text-ink-400 font-mono truncate max-w-[220px]" dir="ltr" title={meta}>{meta}</span>}
                <span className="text-[11.5px] text-ink-500 shrink-0">{r.actor_email || 'نظام'}</span>
                <span className="text-[11px] text-ink-400 tabular-nums shrink-0">{relTime(r.created_at)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
