import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Card, Row } from '../lib/types';
import { useRaiseGridItem } from '../lib/useRaiseGridItem';
import { DEFAULT_CONTEXT, ExportModal, ShareModal, SqlModal, type CardContext } from './CardActions';

interface Props {
  card: Card;
  rows: Row[];
  children: ReactNode;
  /** Optional interactive filter controls rendered between header and chart. */
  controls?: ReactNode;
  /** Current widget context (segment/period/filters) — auto-passed to the action panels. */
  context?: CardContext;
  editMode?: boolean;
  onRemove?: () => void;
  loading?: boolean;
  error?: string;
  /** Small attention chips in the header, e.g. "update available", "partly filtered". */
  notices?: { label: string; title: string }[];
}

const VIA_BADGE: Record<string, string> = {
  builder: 'Builder',
  sql: 'SQL',
  copilot: 'Copilot',
};

export default function CardFrame({ card, rows, children, controls, context = DEFAULT_CONTEXT, editMode = false, onRemove, loading, error, notices = [] }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<'export' | 'sql' | 'share' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useRaiseGridItem(menuOpen, menuRef);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const action = (fn: () => void) => () => { setMenuOpen(false); fn(); };

  return (
    <div className="flex h-full flex-col rounded-2xl border border-line bg-white shadow-[0_1px_3px_rgba(10,28,63,0.06)] transition hover:shadow-[0_4px_16px_rgba(10,28,63,0.08)]">
      <div className={`flex items-start justify-between gap-2 px-4 pt-3.5 pb-1 ${editMode ? 'drag-handle cursor-grab active:cursor-grabbing' : ''}`}>
        <div className="min-w-0">
          <h3 className="truncate font-display text-sm font-bold tracking-tight text-ink" title={card.name}>{card.name}</h3>
          <p className="truncate text-[11px] text-ink-faint" title={card.description}>{card.description || ' '}</p>
        </div>
        <div ref={menuRef} className="relative flex shrink-0 items-center gap-1">
          {notices.map((n) => (
            <span key={n.label} title={n.title} className="whitespace-nowrap rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
              {n.label}
            </span>
          ))}
          <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            {VIA_BADGE[card.created_via] ?? card.created_via}
          </span>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-lg p-1 text-ink-faint transition hover:bg-canvas hover:text-ink"
            aria-label="Card actions"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="3" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="8" cy="13" r="1.4" />
            </svg>
          </button>
          {menuOpen && (
            <div className="rise-in absolute right-0 top-8 z-30 w-44 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
              <MenuItem label="Export data" icon="M8 2v8m0 0l-3-3m3 3l3-3M3 13h10" onClick={action(() => setModal('export'))} />
              <MenuItem label="View SQL script" icon="M5 4l-3 4 3 4m6-8l3 4-3 4" onClick={action(() => setModal('sql'))} />
              <MenuItem label="Send snapshot" icon="M11 5a2 2 0 102-2 2 2 0 00-2 2zm0 0L5 8m0 0a2 2 0 10-2 2 2 2 0 002-2zm0 2l6 3m0 0a2 2 0 102 2 2 2 0 00-2-2z" onClick={action(() => setModal('share'))} />
              {editMode && onRemove && (
                <>
                  <div className="my-1 border-t border-line" />
                  <MenuItem label="Remove from dashboard" icon="M3 5h10M6 5V3h4v2m-5 0v8m4-8v8M4 5l1 9h6l1-9" onClick={action(onRemove)} danger />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {controls && <div className="flex flex-wrap items-center justify-between gap-1.5 px-4 pb-1.5 pt-1">{controls}</div>}

      <div className="min-h-0 flex-1 overflow-hidden rounded-b-2xl px-3 pb-3">
        {error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-negative">{error}</div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" />
          </div>
        ) : (
          children
        )}
      </div>

      {modal === 'export' && <ExportModal card={card} rows={rows} context={context} onClose={() => setModal(null)} />}
      {modal === 'sql' && <SqlModal card={card} context={context} onClose={() => setModal(null)} />}
      {modal === 'share' && <ShareModal card={card} context={context} onClose={() => setModal(null)} />}
    </div>
  );
}

function MenuItem({ label, icon, onClick, danger = false }: { label: string; icon: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition hover:bg-canvas ${danger ? 'text-negative' : 'text-ink-soft hover:text-ink'}`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d={icon} />
      </svg>
      {label}
    </button>
  );
}
