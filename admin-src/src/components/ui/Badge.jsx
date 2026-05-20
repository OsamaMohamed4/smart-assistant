import { cn } from '../../lib/utils';

const TONES = {
  neutral : 'bg-ink-100 text-ink-700 ring-ink-200/60',
  brand   : 'bg-brand-50 text-brand-700 ring-brand-200/60',
  success : 'bg-emerald-50 text-emerald-700 ring-emerald-200/60',
  warning : 'bg-amber-50 text-amber-700 ring-amber-200/60',
  danger  : 'bg-rose-50 text-rose-700 ring-rose-200/60',
  info    : 'bg-sky-50 text-sky-700 ring-sky-200/60',
  outline : 'bg-transparent text-ink-700 ring-ink-200',
};

export function Badge({ tone = 'neutral', className, children, dot, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium ring-1 ring-inset whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span className={cn(
        'w-1.5 h-1.5 rounded-full',
        tone === 'success' && 'bg-emerald-500',
        tone === 'danger'  && 'bg-rose-500',
        tone === 'warning' && 'bg-amber-500',
        tone === 'brand'   && 'bg-brand-500',
        tone === 'info'    && 'bg-sky-500',
        tone === 'neutral' && 'bg-ink-400',
      )} /> : null}
      {children}
    </span>
  );
}
