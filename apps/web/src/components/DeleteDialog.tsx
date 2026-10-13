import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AssetKind } from '../lib/types';
import Modal from './Modal';

const NOUN: Record<AssetKind, string> = { cards: 'card', dashboards: 'dashboard', 'data-sources': 'data source' };
const PATH = { card: (id: number) => `/cards/${id}/edit`, dashboard: (id: number) => `/dashboards/${id}`, data_source: (id: number) => `/data-sources/${id}` };
const DEPENDENT: Record<AssetKind, string> = { cards: 'dashboard', dashboards: 'dashboard', 'data-sources': 'card' };

/** Delete with a look at what it affects first: where it's used, copies of it, open requests. */
export default function DeleteDialog({ kind, asset, onClose, onDeleted }: {
  kind: AssetKind; asset: { id: number; name: string; scope: string }; onClose: () => void; onDeleted?: () => void;
}) {
  const usageQuery = useQuery({ queryKey: ['assets', kind, 'usage', asset.id], queryFn: () => api.usage(kind, asset.id), staleTime: 0 });
  const usage = usageQuery.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const noun = NOUN[kind];
  const uses = usage ? usage.used_by.length + usage.used_by_others : 0;
  const dependent = DEPENDENT[kind];

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.remove(kind, asset.id);
      onDeleted?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${noun} “${asset.name}”?`}
      subtitle={asset.scope === 'global' ? 'It disappears from the global library. An admin can restore it from the Deleted tab.' : 'You can restore it from the Deleted tab.'}
      onClose={onClose}>
      {!usage ? (
        usageQuery.error
          ? <p className="text-sm text-negative">{usageQuery.error.message}</p>
          : <div className="flex justify-center py-6"><div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" /></div>
      ) : (
        <div className="space-y-3 text-sm">
          {uses + usage.copies + usage.open_requests.length === 0 ? (
            <p className="rounded-xl bg-canvas px-4 py-3 text-ink-soft">Nothing uses it — safe to delete.</p>
          ) : (
            <ul className="space-y-2.5">
              {uses > 0 && (
                <li className="rounded-xl border border-line px-4 py-3">
                  <p className="font-semibold text-ink">Used by {uses} {dependent}{uses === 1 ? '' : 's'}</p>
                  <p className="mt-0.5 text-xs text-ink-soft">
                    {usage.used_by.map((d, i) => (
                      <span key={`${d.kind}-${d.id}-${i}`}>{i > 0 && ', '}<Link to={PATH[d.kind](d.id)} className="font-semibold text-accent hover:underline">{d.name}</Link>{d.scope === 'global' ? ' (global)' : ''}</span>
                    ))}
                    {usage.used_by_others > 0 && <>{usage.used_by.length ? ', and ' : ''}{usage.used_by_others} private {dependent}{usage.used_by_others === 1 ? '' : 's'} of other people</>}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {kind === 'data-sources'
                      ? 'They keep working with the version they use. To save changes to one, its owner moves it to another source.'
                      : `They keep working with the version they use, marked “Deleted” — it just gets no more updates and can't be added anywhere new.`}
                  </p>
                </li>
              )}
              {usage.copies > 0 && (
                <li className="rounded-xl border border-line px-4 py-3">
                  <p className="font-semibold text-ink">{usage.copies} {usage.copies === 1 ? 'person has' : 'people have'} their own copy</p>
                  <p className="mt-1 text-xs text-ink-faint">Copies are kept. Proposing one would publish it as a new {noun}.</p>
                </li>
              )}
              {usage.open_requests.length > 0 && (
                <li className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="font-semibold text-amber-900">{usage.open_requests.length} open request{usage.open_requests.length === 1 ? '' : 's'} about it</p>
                  <p className="mt-0.5 text-xs text-amber-900">
                    {usage.open_requests.map((r, i) => (
                      <span key={r.id}>{i > 0 && ', '}<Link to={`/requests/${r.id}`} className="font-semibold underline">#{r.id} {r.title}</Link> ({r.requested_by_name})</span>
                    ))}
                  </p>
                  <p className="mt-1 text-xs text-amber-800">
                    {asset.scope === 'global'
                      ? "Requests that change it can't be approved after it's deleted — reject them, or restore it later."
                      : 'They will be withdrawn automatically, with a note in each conversation.'}
                  </p>
                </li>
              )}
            </ul>
          )}
          {error && <p className="text-negative">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:text-ink">Cancel</button>
            <button onClick={remove} disabled={busy}
              className="rounded-lg bg-negative px-4 py-2 text-sm font-semibold text-white transition enabled:hover:opacity-90 disabled:opacity-50">
              {busy ? 'Deleting…' : `Delete ${noun}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The "Deleted" tab: what this person may bring back. */
export function DeletedList({ kind, items }: {
  kind: AssetKind; items: { id: number; name: string; description: string; scope: string; owner_name: string | null; deleted_at: string | null }[] | undefined;
}) {
  const [busy, setBusy] = useState<number>();
  const [error, setError] = useState<string>();
  const restore = async (id: number) => {
    setBusy(id);
    setError(undefined);
    try {
      await api.undelete(kind, id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  if (!items) return <div className="flex justify-center py-12"><div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" /></div>;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
      {error && <p className="border-b border-line px-5 py-2 text-sm text-negative">{error}</p>}
      {items.map((a) => (
        <div key={a.id} className="flex items-center gap-4 border-b border-line px-5 py-3.5 last:border-0">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold text-ink">{a.name}</p>
            <p className="truncate text-xs text-ink-faint">
              {a.scope === 'global' ? 'Global' : a.owner_name ?? 'Private'}
              {a.deleted_at && ` · deleted ${new Date(a.deleted_at).toLocaleString()}`}
              {a.description && ` · ${a.description}`}
            </p>
          </div>
          <button onClick={() => restore(a.id)} disabled={busy === a.id}
            className="shrink-0 rounded-lg border border-accent px-3 py-1.5 text-xs font-semibold text-accent transition enabled:hover:bg-accent-soft disabled:opacity-50">
            {busy === a.id ? 'Restoring…' : 'Restore'}
          </button>
        </div>
      ))}
      {!items.length && <p className="px-5 py-12 text-center text-sm text-ink-faint">Nothing deleted that you can restore.</p>}
    </div>
  );
}
