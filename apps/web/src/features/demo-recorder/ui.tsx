import { useEffect, useState, type ReactNode } from 'react';

/** Shared bits for the recorder's own UI (independent of the app's components, so the feature stays removable). */

export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export function BlobImage({ blob, className, alt = '' }: { blob: Blob; className?: string; alt?: string }) {
  const url = useObjectUrl(blob);
  return url ? <img src={url} alt={alt} className={className} draggable={false} /> : <div className={className} />;
}

export function Dialog({ title, subtitle, onClose, children, footer, width = 'max-w-lg' }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string;
}) {
  return (
    <div className="fixed inset-0 z-[2147483001] flex items-center justify-center bg-accent-deep/45 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div role="dialog" aria-label={title} className={`flex max-h-[92vh] w-full ${width} flex-col rounded-2xl border border-line bg-white shadow-2xl`}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}><path d="M3 3l10 10M13 3L3 13" /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function IconButton({ label, onClick, children, disabled, className = '' }: {
  label: string; onClick: () => void; children: ReactNode; disabled?: boolean; className?: string;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className={`rounded-lg p-1.5 text-ink-faint transition enabled:hover:bg-canvas enabled:hover:text-ink disabled:opacity-30 ${className}`}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

export const btn = {
  primary: 'rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40',
  secondary: 'rounded-lg border border-line bg-white px-4 py-2 font-display text-sm font-semibold text-ink-soft transition enabled:hover:border-accent/50 enabled:hover:text-ink disabled:opacity-40',
  danger: 'rounded-lg px-3 py-2 text-sm font-semibold text-negative transition hover:bg-negative/10',
};

export const field = 'w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20';
export const label = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft';

export const ICONS = {
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  trash: <path d="M3 5h10M6 5V3h4v2m-5 0v8m4-8v8M4 5l1 9h6l1-9" />,
  recapture: <path d="M2.5 8a5.5 5.5 0 019.4-3.9L13.5 5.5M13.5 2.5v3h-3M13.5 8a5.5 5.5 0 01-9.4 3.9L2.5 10.5M2.5 13.5v-3h3" />,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
};
