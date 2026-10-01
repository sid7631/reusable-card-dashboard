import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Extra-wide, for side-by-side content such as version history. */
  xl?: boolean;
}

export default function Modal({ title, subtitle, onClose, children, wide = false, xl = false }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portaled to <body>: cards live inside transformed react-grid-layout items,
  // which would otherwise clip and reposition this fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-accent-deep/40 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className={`rise-in w-full ${xl ? 'max-w-5xl' : wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl border border-line bg-white shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-faint transition hover:bg-canvas hover:text-ink" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
