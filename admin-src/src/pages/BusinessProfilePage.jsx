import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { EmptyState } from '../components/ui/EmptyState';
import { BusinessProfileEditor } from '../components/companies/BusinessProfileEditor';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';

// The company's FACTS — description, hours, services, rules — which publishing
// renders into the agent's prompt. Structured deliberately like the Knowledge
// Base page: superadmin gets a company switcher, a workspace client is pinned
// to their own company and never sees another tenant's data.
export function BusinessProfilePage({ pinnedCompanyId }) {
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
        title="بيانات الشركة"
        subtitle={
          isWorkspace
            ? 'حقائق شركتك التي يستخدمها الوكيل أثناء المكالمة.'
            : (activeCompany ? `حقائق ${activeCompany.name}` : 'اختر شركة لتحرير بياناتها.')
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
            icon={ClipboardList}
            title="لا توجد شركات"
            description="أنشئ شركة من تبويب الشركات أولاً."
          />
        ) : (
          // Keyed by company so switching tenants remounts with a clean form
          // rather than carrying one company's draft into another's.
          <BusinessProfileEditor
            key={companyId}
            companyId={companyId}
            companyName={activeCompany?.name || ''}
          />
        )}
      </div>
    </div>
  );
}
