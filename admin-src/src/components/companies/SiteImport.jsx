import { useEffect, useRef, useState } from 'react';
import { Globe, RefreshCw, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Label } from '../ui/Input';
import { useToast } from '../ui/Toast';
import { api } from '../../lib/api';
import { cn, fmtDate, fmtNumber } from '../../lib/utils';

// Reads the company's own public website into its knowledge base: each page
// becomes a document the assistant can answer from, in calls and on WhatsApp.
// Reading again replaces that site's earlier pages (and only them), so prices
// stay current without touching files the company uploaded by hand.

const RUNNING = new Set(['reading', 'saving']);

export function SiteImport({ companyId, onDone }) {
  const { push } = useToast();
  const [site, setSite]   = useState(null);
  const [job, setJob]     = useState(null);
  const [url, setUrl]     = useState('');
  const [busy, setBusy]   = useState(false);
  const last = useRef(null);

  const apply = (r, first = false) => {
    setSite(r.site || null);
    setJob(r.job || null);
    if (first && r.site?.url) setUrl((u) => u || r.site.url);
    const state = r.job?.state || null;
    // Tell the person once, when a read that was running in front of them ends.
    if (!first && RUNNING.has(last.current) && state === 'done') {
      push(`تمت قراءة الموقع: ${fmtNumber(r.job.added)} صفحة في قاعدة المعرفة`, 'success');
      onDone?.();
    }
    if (!first && RUNNING.has(last.current) && state === 'failed') push(r.job.error || 'تعذّرت قراءة الموقع', 'error');
    last.current = state;
  };

  useEffect(() => {
    let cancelled = false;
    last.current = null;
    setSite(null); setJob(null); setUrl('');
    api.siteImportStatus(companyId)
      .then((r) => { if (!cancelled) apply(r, true); })
      .catch((e) => { if (!cancelled) push(e.message, 'error'); });
    return () => { cancelled = true; };
  }, [companyId]);

  // While a read is running, look again every few seconds.
  useEffect(() => {
    if (!RUNNING.has(job?.state)) return undefined;
    const t = setInterval(() => {
      api.siteImportStatus(companyId).then((r) => apply(r)).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [job?.state, companyId]);

  const running = RUNNING.has(job?.state);

  const start = async (address) => {
    const target = String(address || '').trim();
    if (!target) { push('اكتب رابط الموقع أولاً', 'error'); return; }
    setBusy(true);
    try {
      await api.startSiteImport(companyId, target);
      last.current = 'reading';
      apply(await api.siteImportStatus(companyId));
      last.current = 'reading';
    } catch (e) { push(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const progress = !job ? null
    : job.state === 'reading' ? `جارٍ قراءة الموقع… ${fmtNumber(job.found)} صفحة حتى الآن`
    : job.state === 'saving'  ? `جارٍ حفظ الصفحات في قاعدة المعرفة… ${fmtNumber(job.added + job.failed)} من ${fmtNumber(job.total)}`
    : null;

  return (
    <Card className="p-5 space-y-4 mb-6">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
          <Globe className="w-4 h-4" strokeWidth={2} />
        </div>
        <div>
          <div className="text-[14px] font-semibold text-ink-900">استيراد من موقع الشركة</div>
          <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
            اكتب رابط موقعكم ليقرأ النظام صفحاته (المشاريع، المواصفات، الأسعار، التوفر) ويضيفها إلى قاعدة المعرفة، فيجيب منها المساعد في المكالمات وواتساب.
          </p>
        </div>
      </div>

      <div>
        <Label>رابط الموقع</Label>
        <div className="flex gap-2">
          <input
            value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" disabled={running}
            placeholder="https://example.com"
            className="flex-1 h-10 px-3 rounded-xl border border-ink-200 bg-white text-[13px] focus-ring disabled:opacity-60"
          />
          <Button variant="brand" onClick={() => start(url)} loading={busy} disabled={running}>
            {site?.url && url.trim() === site.url ? 'إعادة السحب' : 'بدء السحب'}
          </Button>
        </div>
      </div>

      {progress && (
        <div className="flex items-center gap-2 rounded-xl bg-sky-50 text-sky-800 px-4 py-3 text-[12.5px]">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          <span>{progress}. يمكنك مغادرة الصفحة، فالسحب يكمل في الخلفية.</span>
        </div>
      )}

      {job?.state === 'failed' && (
        <div className="flex items-start gap-2 rounded-xl bg-rose-50 text-rose-800 px-4 py-3 text-[12.5px] leading-relaxed">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{job.error}</span>
        </div>
      )}

      {job?.state === 'done' && (
        <div className="flex items-start gap-2 rounded-xl bg-emerald-50 text-emerald-800 px-4 py-3 text-[12.5px] leading-relaxed">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            أُضيفت {fmtNumber(job.added)} صفحة
            {job.replaced ? `، واستُبدلت ${fmtNumber(job.replaced)} صفحة من السحب السابق` : ''}
            {job.failed ? `. تعذّر حفظ ${fmtNumber(job.failed)} صفحة` : ''}.
          </span>
        </div>
      )}

      {site && !running && (
        <div className={cn('flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-500')}>
          <span>
            آخر سحب: <span dir="ltr" className="font-mono">{site.url}</span> · {fmtNumber(site.pages)} صفحة · {fmtDate(site.lastReadAt)}
          </span>
          <button type="button" onClick={() => start(site.url)} disabled={busy}
            className="inline-flex items-center gap-1.5 text-brand-700 hover:underline disabled:opacity-50">
            <RefreshCw className="w-3.5 h-3.5" /> أعد السحب الآن
          </button>
        </div>
      )}

      <p className="text-[11.5px] text-ink-400 leading-relaxed">
        يقرأ الصفحات العامة للموقع فقط. يعرف المساعد ما في الموقع وقت آخر سحب، فأعد السحب عند تغيّر الأسعار أو توفر الوحدات.
        الملفات التي رفعتها يدويًا لا تتأثر.
      </p>
    </Card>
  );
}
