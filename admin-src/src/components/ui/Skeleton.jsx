import { cn } from '../../lib/utils';

export function Skeleton({ className, ...props }) {
  return <div className={cn('shimmer rounded-lg', className)} {...props} />;
}

export function CompanyCardSkeleton() {
  return (
    <div className="bg-white border border-ink-100 rounded-2xl p-5 shadow-card">
      <div className="flex items-start gap-4 mb-5">
        <Skeleton className="w-12 h-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-5">
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
      </div>
      <Skeleton className="h-9 rounded-xl" />
    </div>
  );
}

export function RowSkeleton() {
  return (
    <div className="bg-white border border-ink-100 rounded-xl p-4 flex items-center gap-4">
      <Skeleton className="w-10 h-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="w-20 h-7 rounded-md" />
    </div>
  );
}
