import { gradientFor, initial, cn } from '../../lib/utils';

export function Avatar({ name, size = 40, className }) {
  const [from, to] = gradientFor(name);
  const ch = initial(name);
  return (
    <div
      className={cn('flex items-center justify-center font-semibold text-white shrink-0', className)}
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`,
        borderRadius: Math.round(size * 0.32),
        fontSize: Math.round(size * 0.42),
        letterSpacing: '-0.02em',
        boxShadow: '0 1px 0 rgba(255,255,255,0.18) inset, 0 6px 14px -4px rgba(14,15,18,0.15)',
      }}
    >
      {ch}
    </div>
  );
}
