import { useState } from 'react';
import { api } from '../lib/api';
import { useDiff } from '../lib/queries';
import type { DashboardDetail, DashboardItem } from '../lib/types';
import Modal from './Modal';
import DiffList from './DiffList';

interface Props {
  dashboardId: number;
  item: DashboardItem;
  /** False for viewers, or while the layout has unsaved changes. */
  canApply: boolean;
  /** Why applying is unavailable, shown instead of the button. */
  blockedReason?: string;
  onClose: () => void;
  onApplied: (dashboard: DashboardDetail) => void;
}

/** What changed between the card version a dashboard pins and the card's latest — and re-pin just this card. */
export default function CardUpdateDialog({ dashboardId, item, canApply, blockedReason, onClose, onApplied }: Props) {
  // A viewer of a shared dashboard may not see the card itself; its history is then unavailable
  const diffQuery = useDiff('cards', item.id, item.access ? item.version_no : undefined, item.latest_version_no);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onApplied(await api.applyUpdates(dashboardId, [item.item_id!]));
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal wide title={`Update “${item.name}”`}
      subtitle={`This dashboard shows v${item.version}; the card is now at v${item.latest_version ?? '?'}. Other cards are not affected.`}
      onClose={onClose}>
      <div className="max-h-[50vh] overflow-auto">
        {!item.access ? (
          <p className="rounded-xl bg-canvas px-4 py-4 text-sm text-ink-faint">You don't have access to this card's history.</p>
        ) : diffQuery.isPending ? (
          <div className="flex justify-center py-8"><div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" /></div>
        ) : diffQuery.error ? (
          <p className="text-sm text-negative">{diffQuery.error.message}</p>
        ) : diffQuery.data && diffQuery.data.changes.length ? (
          <DiffList diff={diffQuery.data} />
        ) : (
          <p className="rounded-xl bg-canvas px-4 py-4 text-sm text-ink-faint">No visible changes between these versions.</p>
        )}
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        {error && <span className="mr-auto text-sm text-negative">{error}</span>}
        {!canApply && blockedReason && <span className="mr-auto text-xs text-ink-soft">{blockedReason}</span>}
        <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:text-ink">
          {canApply ? 'Not now' : 'Close'}
        </button>
        {canApply && (
          <button onClick={apply} disabled={busy}
            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition enabled:hover:bg-amber-600 disabled:opacity-50">
            {busy ? 'Updating…' : `Update this card to v${item.latest_version}`}
          </button>
        )}
      </div>
    </Modal>
  );
}
