import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { EmptyState } from '../components/ui/EmptyState';
import { DocumentsManager } from '../components/companies/DocumentsManager';
import { Label } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';

// Knowledge base management as a first-class sidebar page (matches sarj's
// layout). Superadmin sees a company switcher; clients are pinned to their
// workspace and skip straight to their company's documents.
//
// Two knowledge bases per company, one per agent (lib/kb-audience.js).
const KB_SECTIONS = [
  { audience: 'inbound', title: 'ملفات المكالمات الواردة وواتساب', hint: 'ما يعرفه المساعد حين يتصل العميل أو يراسل الشركة على واتساب.' },
  { audience: 'outbound', title: 'ملفات المكالمات الصادرة', hint: 'ما يعرفه المساعد حين يتصل هو بالعميل، كالحملات.' },
];
export function KnowledgeBasesPage({ pinnedCompanyId }) {
  const { push } = useToast();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState(pinnedCompanyId || null);

  useEffect(() => {
    if (pinnedCompanyId) { setCompanyId(pinnedCompanyId); return; }
    api.listCompanies().then((cs) => {
      setCompanies(cs || []);
      setCompanyId((curr) => curr || cs?.[0]?.id || null);
    }).catch((e) => push(e.message, 'error'));
  }, [pinnedCompanyId]);

  const activeCompany = companies.find((c) => c.id === companyId);
  const isWorkspace   = !!pinnedCompanyId;

  return (
    <div>
      <TopBar
        title="قاعدة المعرفة"
        subtitle={
          isWorkspace
            ? 'مستندات الشركة التي يستخدمها الوكيل في الردود.'
            : (activeCompany ? `مستندات ${activeCompany.name}` : 'اختر شركة لعرض مستنداتها.')
        }
        right={
          !isWorkspace && companies.length > 1 && (
            <select
              value={companyId || ''}
              onChange={(e) => setCompanyId(e.target.value)}
              className="h-9 px-3 pr-9 bg-white border border-ink-200 rounded-xl text-[13px] focus-ring focus:border-ink-300"
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )
        }
      />

      <div className="px-8 py-7 max-w-3xl space-y-8">
        {!companyId ? (
          <EmptyState
            icon={BookOpen}
            title="لا توجد شركات"
            description="أنشئ شركة من تبويب الشركات أولاً."
          />
        ) : (
          <>
            <p className="text-[12.5px] text-ink-500 leading-relaxed">
              لكل شركة قاعدتا معرفة: واحدة لمساعد المكالمات الواردة وواتساب، وواحدة لمساعد المكالمات الصادرة، ولا يرى أحدهما ملفات الآخر.
              الملف الذي يحتاجه الاثنان يُرفع في المكانين. بعد أي تغيير اضغط «نشر» للشركة حتى يصل إلى المساعد الصوتي.
              وإن لم يكن في سيناريو الشركة تعليمات للمكالمات الواردة، فالمساعد واحد ويستخدم ملفات المكانين.
            </p>
            {KB_SECTIONS.map((s) => (
              <section key={s.audience} className="space-y-3">
                <div>
                  <h2 className="text-[15px] font-semibold text-ink-900">{s.title}</h2>
                  <p className="text-[12px] text-ink-500 mt-0.5">{s.hint}</p>
                </div>
                <DocumentsManager companyId={companyId} companyName={activeCompany?.name || ''} audience={s.audience} />
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
