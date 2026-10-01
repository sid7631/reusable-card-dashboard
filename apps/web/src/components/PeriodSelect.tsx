import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useRaiseGridItem } from '../lib/useRaiseGridItem';
import { schemeColors } from '../lib/format';

export interface Period {
  label: string;
  from?: string;
  to?: string;
}

export type PeriodGranularity = 'month' | 'quarter' | 'year' | 'ytd';

export const DEFAULT_PERIOD: Period = { label: '2026 YTD', from: '2026-01-01', to: '2026-06-11' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthPeriod = (i: number): Period => {
  const mm = String(i + 1).padStart(2, '0');
  const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
  return { label: `${MONTHS[i]} '26`, from: `2026-${mm}-01`, to: `2026-${mm}-${String(last).padStart(2, '0')}` };
};
const quarterPeriod = (q: number): Period => ({
  label: `Q${q} '26`,
  from: `2026-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`,
  to: `2026-${String(q * 3).padStart(2, '0')}-${q === 1 ? '31' : q === 2 ? '30' : q === 3 ? '30' : '31'}`,
});
const yearPeriod = (y: number): Period => ({ label: `FY '${String(y).slice(2)}`, from: `${y}-01-01`, to: `${y}-12-31` });

const SECTIONS: { id: PeriodGranularity; title: string; periods: Period[] }[] = [
  { id: 'month', title: 'Month (2026)', periods: MONTHS.map((_, i) => monthPeriod(i)) },
  { id: 'quarter', title: 'Quarter', periods: [1, 2, 3, 4].map(quarterPeriod) },
  { id: 'year', title: 'Full year', periods: [2023, 2024, 2025, 2026].map(yearPeriod) },
  { id: 'ytd', title: 'Year-to-date', periods: [DEFAULT_PERIOD, { label: 'All time' }] },
];

interface Props {
  value: Period;
  onChange: (p: Period) => void;
  /** Which granularity sections to offer (card-level configuration). Default: all. */
  options?: PeriodGranularity[];
  compact?: boolean;
  /** Card color scheme id — active/hover states adopt it. Default: classic blue. */
  scheme?: string;
}

export default function PeriodSelect({ value, onChange, options, compact = false, scheme }: Props) {
  // Card scheme wins; otherwise follow the app-level theme variables
  const colors = schemeColors(scheme);
  const schemeVars = (scheme
    ? { '--cs-a': colors[0], '--cs-d': colors[1], '--cs-s': colors[0] + '1a' }
    : { '--cs-a': 'var(--color-accent)', '--cs-d': 'var(--color-accent-deep)', '--cs-s': 'var(--color-accent-soft)' }) as CSSProperties;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Period>(value);
  const ref = useRef<HTMLDivElement>(null);
  useRaiseGridItem(open, ref);

  useEffect(() => { setPending(value); }, [value, open]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const sections = SECTIONS.filter((s) => !options?.length || options.includes(s.id));

  return (
    <div ref={ref} style={schemeVars} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center rounded-full border border-line bg-white font-display font-semibold text-ink transition hover:border-(--cs-a) ${
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
        <div className="rise-in absolute right-0 z-40 mt-2 w-[340px] rounded-2xl border border-line bg-white p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-display text-xs font-bold uppercase tracking-wide text-ink-soft">Reporting period</p>
            <span className="rounded-full bg-(--cs-s) px-2.5 py-0.5 text-[10px] font-semibold text-(--cs-a)">{pending.label}</span>
          </div>
          <div className="max-h-72 space-y-3 overflow-auto pr-1">
            {sections.map((sec) => (
              <div key={sec.id}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{sec.title}</p>
                <div className="flex flex-wrap gap-1.5">
                  {sec.periods.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => setPending(p)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                        pending.label === p.label
                          ? 'border-(--cs-a) bg-(--cs-a) text-white'
                          : 'border-line bg-white text-ink-soft hover:border-(--cs-a) hover:text-ink'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-ink-faint">Single-select — pick one granularity/period combination, then apply.</p>
          <div className="mt-2 flex justify-end gap-2 border-t border-line pt-3">
            <button
              onClick={() => setPending(DEFAULT_PERIOD)}
              className="rounded-lg border border-line px-3.5 py-1.5 text-xs font-semibold text-ink transition hover:bg-canvas"
            >
              Reset
            </button>
            <button
              onClick={() => { onChange(pending); setOpen(false); }}
              className="rounded-lg bg-(--cs-a) px-4 py-1.5 text-xs font-bold text-white transition hover:bg-(--cs-d)"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
