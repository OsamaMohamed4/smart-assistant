import { cn } from '../../lib/utils';

export function Card({ className, hover, children, ...props }) {
  return (
    <div
      className={cn(
        'bg-white border border-ink-100 rounded-2xl shadow-card transition-all duration-200',
        hover && 'hover:shadow-pop hover:border-ink-200 hover:-translate-y-0.5',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }) {
  return <div className={cn('p-5 border-b border-ink-100', className)} {...props}>{children}</div>;
}
export function CardBody({ className, children, ...props }) {
  return <div className={cn('p-5', className)} {...props}>{children}</div>;
}
export function CardFooter({ className, children, ...props }) {
  return <div className={cn('px-5 py-3 border-t border-ink-100 bg-ink-50/40 rounded-b-2xl', className)} {...props}>{children}</div>;
}
