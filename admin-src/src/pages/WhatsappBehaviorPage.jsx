import { TopBar } from '../components/layout/TopBar';
import { WhatsappBehavior } from '../components/companies/WhatsappBehavior';

// The company's own view of its WhatsApp assistant: what it says, what it
// knows, and when it answers. The connection itself stays with the platform
// admin (WhatsappPage).
export function WhatsappBehaviorPage({ user, pinnedCompanyId }) {
  const companyId = pinnedCompanyId || user?.companyId || null;
  return (
    <div>
      <TopBar title="رد واتساب" subtitle="تعليمات المساعد ومعرفته وساعات رده على واتساب." />
      <div className="px-8 py-7 max-w-4xl">
        {companyId
          ? <WhatsappBehavior companyId={companyId} />
          : <div className="text-[13px] text-ink-500">لا توجد شركة مرتبطة بحسابك.</div>}
      </div>
    </div>
  );
}
