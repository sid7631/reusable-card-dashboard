import { useEffect, useRef, useState } from 'react';
import { useRaiseGridItem } from '../lib/useRaiseGridItem';

export interface SegmentSelection {
  segment: string; // 'ALL' | 'USCS' | 'GCS' | 'ICS'
  subSegments?: string[]; // subset filter within GCS / ICS; empty = all
}

export const SEGMENT_OPTIONS = [
  { id: 'ALL', label: 'Total AXP' },
  { id: 'USCS', label: 'USCS' },
  { id: 'GCS', label: 'GCS' },
  { id: 'ICS', label: 'ICS' },
];

/** Multi-select sub-segment breakdowns (per the segment-toggles mockup). */
export const SUB_SEGMENTS: Record<string, string[]> = {
  GCS: ['SBS', 'MM', 'G&L'],
  ICS: ['Consumer', 'SBS', 'Corporate'],
};

export function segmentLabel(sel: SegmentSelection): string {
  const base = SEGMENT_OPTIONS.find((s) => s.id === sel.segment)?.label ?? sel.segment;
  return sel.subSegments?.length ? `${base} · ${sel.subSegments.join(', ')}` : base;
}

interface Props {
  value: SegmentSelection;
  onChange: (sel: SegmentSelection) => void;
  /** Which segment chips to offer (card-level configuration). Default: all. */
  options?: string[];
  compact?: boolean;
}

export default function SegmentToggles({ value, onChange, options, compact = false }: Props) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useRaiseGridItem(Boolean(openFor), ref);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenFor(null);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const visible = SEGMENT_OPTIONS.filter((s) => !options?.length || options.includes(s.id));

  const pick = (id: string) => {
    const multi = SUB_SEGMENTS[id];
    if (!multi) {
      onChange({ segment: id, subSegments: [] });
      setOpenFor(null);
      return;
    }
    // Multi-select segment: select it (all sub-segments) and open the breakdown
    if (value.segment !== id) onChange({ segment: id, subSegments: [] });
    setOpenFor(openFor === id ? null : id);
  };

  const toggleSub = (id: string, sub: string) => {
    const all = SUB_SEGMENTS[id];
    const current = value.subSegments?.length ? value.subSegments : all;
    const next = current.includes(sub) ? current.filter((s) => s !== sub) : [...current, sub];
    // Everything selected is stored as [] (no sub-segment filter)
    onChange({ segment: id, subSegments: next.length === all.length ? [] : next });
  };

  return (
    <div ref={ref} className={`flex items-center rounded-full border border-line bg-white ${compact ? 'gap-0.5 p-0.5' : 'gap-1 p-1 shadow-sm'}`}>
      {visible.map((s) => {
        const active = value.segment === s.id;
        const multi = SUB_SEGMENTS[s.id];
        const subCount = active ? value.subSegments?.length ?? 0 : 0;
        return (
          <div key={s.id} className="relative">
            <button
              onClick={() => pick(s.id)}
              className={`flex items-center gap-1 rounded-full font-display font-semibold transition ${
                compact ? 'px-2 py-0.5 text-[10px]' : 'px-4 py-1.5 text-sm'
              } ${active ? 'bg-accent-deep text-white shadow' : 'text-ink-soft hover:bg-canvas hover:text-ink'}`}
            >
              {s.label}
              {subCount > 0 && <span className="rounded-full bg-white/25 px-1 text-[9px] leading-3">{subCount}</span>}
              {multi && (
                <svg width={compact ? 7 : 9} height={compact ? 7 : 9} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8"
                  className={`transition ${openFor === s.id ? 'rotate-180' : ''}`}>
                  <path d="M2 3.5l3 3 3-3" />
                </svg>
              )}
            </button>
            {multi && openFor === s.id && (
              <div className="rise-in absolute left-0 top-full z-40 mt-2 w-44 rounded-xl border border-line bg-white p-2 shadow-xl">
                <p className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Multi-select</p>
                {multi.map((sub) => {
                  const checked = !value.subSegments?.length || value.subSegments.includes(sub);
                  return (
                    <label key={sub} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm text-ink transition hover:bg-canvas">
                      <input type="checkbox" checked={checked} onChange={() => toggleSub(s.id, sub)} className="size-3.5 accent-[#016fd0]" />
                      {sub}
                    </label>
                  );
                })}
                <p className="mt-1 border-t border-line px-1.5 pt-1.5 text-[10px] text-ink-faint">
                  None checked = all sub-segments
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
