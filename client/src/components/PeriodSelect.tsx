import { useEffect, useRef, useState } from 'react';
import { useRaiseGridItem } from '../lib/useRaiseGridItem';

export interface Period {
  label: string;
  from?: string;
  to?: string;
}

export const PERIODS: Period[] = [
  { label: '2026 YTD', from: '2026-01-01', to: '2026-06-11' },
  { label: 'Q2 2026', from: '2026-04-01', to: '2026-06-11' },
  { label: 'Q1 2026', from: '2026-01-01', to: '2026-03-31' },
  { label: 'FY 2025', from: '2025-01-01', to: '2025-12-31' },
  { label: 'FY 2024', from: '2024-01-01', to: '2024-12-31' },
  { label: 'Last 30 days', from: '2026-05-12', to: '2026-06-11' },
  { label: 'Last 90 days', from: '2026-03-13', to: '2026-06-11' },
  { label: 'All time' },
];

interface Props {
  value: Period;
  onChange: (p: Period) => void;
  compact?: boolean;
}

export default function PeriodSelect({ value, onChange, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useRaiseGridItem(open, ref);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center rounded-full border border-line bg-white font-display font-semibold text-ink transition hover:border-accent ${
          compact ? 'gap-1 px-2.5 py-0.5 text-[10px]' : 'gap-2 px-4 py-2 text-sm shadow-sm'
        }`}
      >
        <svg width={compact ? 11 : 14} height={compact ? 11 : 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
        </svg>
        {value.label}
        <svg width={compact ? 8 : 10} height={compact ? 8 : 10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" className={`transition ${open ? 'rotate-180' : ''}`}>
          <path d="M2 3.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div className={`rise-in absolute right-0 z-40 mt-2 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-xl ${compact ? 'w-36' : 'w-44'}`}>
          {PERIODS.map((p) => (
            <button
              key={p.label}
              onClick={() => { onChange(p); setOpen(false); }}
              className={`block w-full px-4 text-left transition hover:bg-accent-soft ${compact ? 'py-1.5 text-xs' : 'py-2 text-sm'} ${
                p.label === value.label ? 'font-semibold text-accent' : 'text-ink-soft'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
