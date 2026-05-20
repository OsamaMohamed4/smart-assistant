import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e) => { e.preventDefault(); onClose?.(); };
    el.addEventListener('cancel', onCancel);
    el.addEventListener('close', () => onClose?.());
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);

  const widths = {
    sm: 'w-[440px]',
    md: 'w-[560px]',
    lg: 'w-[720px]',
    xl: 'w-[920px]',
  };

  return (
    <dialog ref={ref} className={cn('rounded-2xl', widths[size], 'max-w-[95vw]')}>
      <div className="bg-white rounded-2xl shadow-pop overflow-hidden flex flex-col max-h-[90vh] animate-slide-up">
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-ink-100">
          <div className="flex-1 min-w-0">
            {title && <h2 className="text-[16px] font-semibold text-ink-900 leading-tight">{title}</h2>}
            {description && <p className="text-[13px] text-ink-500 mt-1">{description}</p>}
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 hover:bg-ink-100 w-8 h-8 rounded-lg flex items-center justify-center transition-colors focus-ring">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>
        {footer && (
          <div className="px-6 py-4 border-t border-ink-100 bg-ink-50/60 flex items-center justify-end gap-2 flex-row-reverse">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'متأكد', confirmVariant = 'primary' }) {
  return (
    <Modal
      open={open} onClose={onClose} size="sm" title={title}
      footer={<>
        <Button variant={confirmVariant === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        <Button variant="ghost" onClick={onClose}>إلغاء</Button>
      </>}
    >
      <p className="text-[13.5px] text-ink-700 leading-relaxed">{message}</p>
    </Modal>
  );
}
