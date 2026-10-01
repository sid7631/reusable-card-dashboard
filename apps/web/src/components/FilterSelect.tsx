import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useRaiseGridItem } from '../lib/useRaiseGridItem';
import { schemeColors } from '../lib/format';

interface Props {
  label: string;
  value: string[];
  onChange: (values: string[]) => void;
  /** Loads the options; called when the menu opens and whenever `loadKey` changes while open. */
  load: () => Promise<string[]>;
  loadKey: string;
  multi?: boolean;
  compact?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why the control is disabled. */
  title?: string;
  /** Restrict to these values (card-level configuration). */
  allowed?: string[];
  scheme?: string;
}

/** Dropdown chip for one dimension filter. Empty selection = all values. */
export default function FilterSelect({ label, value, onChange, load, loadKey, multi = false, compact = false,
  disabled = false, title, allowed, scheme }: Props) {
  const colors = schemeColors(scheme);
  const vars = (scheme
    ? { '--cs-a': colors[0], '--cs-s': colors[0] + '1a' }
    : { '--cs-a': 'var(--color-accent)', '--cs-s': 'var(--color-accent-soft)' }) as CSSProperties;
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  useRaiseGridItem(open, ref);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setOptions(undefined);
    setError(undefined);
    load().then((o) => alive && setOptions(o)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [open, loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = (options ?? [])
    .filter((o) => !allowed?.length || allowed.includes(o))
    .filter((o) => !query || o.toLowerCase().includes(query.toLowerCase()));

  const toggle = (o: string) => {
    if (!multi) {
      onChange(value[0] === o ? [] : [o]);
      setOpen(false);
      return;
    }
    onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  };

  const summary = !value.length ? 'All' : value.length <= 2 ? value.join(', ') : `${value.length} selected`;

  return (
    <div ref={ref} style={vars} className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        className={`flex max-w-56 items-center rounded-full border font-display font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
          value.length ? 'border-(--cs-a) bg-(--cs-s) text-(--cs-a)' : 'border-line bg-white text-ink'
        } ${compact ? 'gap-1 px-2.5 py-0.5 text-[10px]' : 'gap-2 px-4 py-2 text-sm shadow-sm'} enabled:hover:border-(--cs-a)`}
      >
        <span className={compact ? 'text-ink-faint' : 'text-ink-soft'}>{label}:</span>
        <span className="truncate">{summary}</span>
        {disabled && title ? (
          <svg width={compact ? 9 : 11} height={compact ? 9 : 11} viewBox="0 0 16 16" fill="currentColor" aria-label="Locked"><path d="M5 7V5a3 3 0 016 0v2h1v7H4V7h1zm1.5 0h3V5a1.5 1.5 0 00-3 0v2z" /></svg>
        ) : (
          <svg width={compact ? 8 : 10} height={compact ? 8 : 10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" className={`shrink-0 transition ${open ? 'rotate-180' : ''}`}>
            <path d="M2 3.5l3 3 3-3" />
          </svg>
        )}
      </button>

      {open && (
        <div className="rise-in absolute left-0 z-40 mt-2 w-64 rounded-2xl border border-line bg-white p-3 shadow-xl">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${label.toLowerCase()}`}
            className="mb-2 w-full rounded-lg border border-line px-2.5 py-1.5 text-xs outline-none focus:border-(--cs-a)" />
          <div className="max-h-60 overflow-auto">
            {!multi && (
              <button onClick={() => { onChange([]); setOpen(false); }}
                className={`block w-full rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-canvas ${!value.length ? 'font-bold text-(--cs-a)' : 'text-ink-soft'}`}>
                All
              </button>
            )}
            {visible.map((o) => (
              <button key={o} onClick={() => toggle(o)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-canvas ${value.includes(o) ? 'font-bold text-(--cs-a)' : 'text-ink'}`}>
                {multi && (
                  <span className={`flex size-3.5 shrink-0 items-center justify-center rounded border ${value.includes(o) ? 'border-(--cs-a) bg-(--cs-a) text-white' : 'border-line'}`}>
                    {value.includes(o) && <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 5l2 2 4-4" /></svg>}
                  </span>
                )}
                <span className="truncate">{o}</span>
              </button>
            ))}
            {options && !visible.length && <p className="px-2.5 py-2 text-xs text-ink-faint">No values.</p>}
            {!options && !error && <div className="flex justify-center py-3"><div className="size-4 animate-spin rounded-full border-2 border-line border-t-(--cs-a)" /></div>}
            {error && <p className="px-2.5 py-2 text-xs text-negative">{error}</p>}
          </div>
          {multi && value.length > 0 && (
            <div className="mt-2 flex justify-between border-t border-line pt-2">
              <button onClick={() => onChange([])} className="text-xs font-semibold text-ink-soft hover:text-ink">Clear</button>
              <button onClick={() => setOpen(false)} className="rounded-lg bg-(--cs-a) px-3 py-1 text-xs font-bold text-white">Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
