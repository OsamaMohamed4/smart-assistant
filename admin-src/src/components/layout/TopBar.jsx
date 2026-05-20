import { Search, Command } from 'lucide-react';
import { cn } from '../../lib/utils';

export function TopBar({ title, subtitle, right, sticky = true, search, onSearch, searchPlaceholder = 'ابحث...', className }) {
  return (
    <div className={cn(
      'glass border-b border-ink-100 z-20',
      sticky && 'sticky top-0',
      className,
    )}>
      <div className="px-8 py-4 flex items-center gap-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-[20px] font-bold text-ink-900 tracking-[-0.01em] leading-tight">{title}</h1>
          {subtitle && <p className="text-[12.5px] text-ink-500 mt-0.5">{subtitle}</p>}
        </div>

        {onSearch !== undefined && (
          <div className="relative w-[300px]">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-400" strokeWidth={2} />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full h-9 pr-9 pl-12 text-[13px] bg-white/80 border border-ink-200 rounded-xl placeholder:text-ink-400 focus-ring focus:border-ink-300"
            />
            <kbd className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-ink-500 bg-ink-100 border border-ink-200 px-1.5 py-0.5 rounded">
              <Command className="inline w-2.5 h-2.5 -mt-0.5" /> K
            </kbd>
          </div>
        )}

        {right}
      </div>
    </div>
  );
}
