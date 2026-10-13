import { Link } from 'react-router-dom';

/** Shown instead of silently redirecting when a card, dashboard or data source can't be opened. */
export default function NotFound({ noun, back, backLabel, detail }: {
  noun: 'card' | 'dashboard' | 'data source';
  back: string;
  backLabel: string;
  /** The server's message, e.g. "Card not found." */
  detail?: string;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-8">
      <div className="max-w-md rounded-2xl border border-line bg-white p-8 text-center shadow-sm">
        <p className="font-display text-lg font-bold text-ink">This {noun} can't be opened</p>
        <p className="mt-2 text-sm text-ink-soft">
          It may have been deleted, or it's private and hasn't been shared with you. Deleted items can be restored from the
          Deleted tab by their owner (or an admin, for global ones).
        </p>
        {detail && <p className="mt-2 text-xs text-ink-faint">{detail}</p>}
        <Link to={back} className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-deep">
          {backLabel}
        </Link>
      </div>
    </div>
  );
}
