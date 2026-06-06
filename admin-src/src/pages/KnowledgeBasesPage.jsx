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

      <div className="px-8 py-7 max-w-3xl">
        {!companyId ? (
          <EmptyState
            icon={BookOpen}
            title="لا توجد شركات"
            description="أنشئ شركة من تبويب الشركات أولاً."
          />
        ) : (
          <DocumentsManager companyId={companyId} companyName={activeCompany?.name || ''} />
        )}
      </div>
    </div>
  );
}
