import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Check, X, AlertCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

const ToastCtx = createContext({ push: () => {} });

export function useToast() { return useContext(ToastCtx); }

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((msg, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((s) => [...s, { id, msg, kind }]);
    setTimeout(() => setToasts((s) => s.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-6 left-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-3 px-4 py-3 pr-3 rounded-xl shadow-pop',
              'bg-ink-950 text-white min-w-[280px] max-w-md animate-slide-up'
            )}
          >
            <span className={cn(
              'mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0',
              t.kind === 'success' && 'bg-emerald-500',
              t.kind === 'error'   && 'bg-rose-500',
              t.kind === 'info'    && 'bg-brand-500',
            )}>
              {t.kind === 'success' ? <Check className="w-3 h-3" strokeWidth={3} /> :
               t.kind === 'error'   ? <X className="w-3 h-3" strokeWidth={3} /> :
                                      <AlertCircle className="w-3 h-3" strokeWidth={2.5} />}
            </span>
            <p className="text-[13.5px] leading-relaxed flex-1">{t.msg}</p>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
