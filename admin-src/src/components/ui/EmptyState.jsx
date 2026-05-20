import { cn } from '../../lib/utils';

export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center py-20 px-6',
      'rounded-2xl border border-dashed border-ink-200 bg-ink-50/40',
      className,
    )}>
      {Icon && (
        <div className="w-12 h-12 rounded-2xl bg-white border border-ink-100 shadow-soft flex items-center justify-center mb-4 text-ink-500">
          <Icon className="w-5 h-5" strokeWidth={1.8} />
        </div>
      )}
      <h3 className="text-[15px] font-semibold text-ink-900 mb-1">{title}</h3>
      {description && <p className="text-[13px] text-ink-500 max-w-sm leading-relaxed">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
