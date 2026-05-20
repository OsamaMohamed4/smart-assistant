import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

export const Input = forwardRef(function Input(
  { className, leftIcon, rightIcon, ...props }, ref
) {
  return (
    <div className="relative">
      {leftIcon && (
        <span className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-ink-400">
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        className={cn(
          'block w-full h-10 rounded-xl border border-ink-200 bg-white px-3.5 text-[14px]',
          'placeholder:text-ink-400 text-ink-900',
          'transition-shadow duration-150 focus-ring focus:border-ink-400',
          leftIcon && 'pr-10',
          rightIcon && 'pl-10',
          className,
        )}
        {...props}
      />
      {rightIcon && (
        <span className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-ink-400">
          {rightIcon}
        </span>
      )}
    </div>
  );
});

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'block w-full rounded-xl border border-ink-200 bg-white px-3.5 py-3 text-[14px]',
        'placeholder:text-ink-400 text-ink-900 leading-relaxed',
        'transition-shadow duration-150 focus-ring focus:border-ink-400 resize-y',
        'font-arabic',
        className,
      )}
      {...props}
    />
  );
});

export function Label({ className, children, hint, ...props }) {
  return (
    <label className={cn('block text-[13px] font-medium text-ink-700 mb-1.5', className)} {...props}>
      {children}
      {hint && <span className="text-ink-400 font-normal mr-1">— {hint}</span>}
    </label>
  );
}
