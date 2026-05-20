import { cn } from '../../lib/utils';

const VARIANTS = {
  primary  : 'bg-ink-900 text-white hover:bg-ink-800 active:bg-ink-950 shadow-soft',
  secondary: 'bg-white text-ink-800 border border-ink-200 hover:border-ink-300 hover:bg-ink-50 active:bg-ink-100',
  ghost    : 'text-ink-700 hover:bg-ink-100 active:bg-ink-200',
  brand    : 'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 shadow-soft',
  danger   : 'bg-white text-accent-rose border border-ink-200 hover:bg-accent-rose hover:text-white hover:border-accent-rose',
  outline  : 'bg-transparent text-ink-700 border border-ink-200 hover:border-ink-400 hover:bg-white',
};

const SIZES = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-[13px] gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-9 w-9 p-0',
};

export function Button({
  variant = 'secondary', size = 'md', className, children, loading, disabled, ...props
}) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium rounded-xl select-none transition-all duration-150',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus-ring',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : null}
      {children}
    </button>
  );
}
