import { useState } from 'react';
import { api } from '../lib/api';
import { useDiff, useVersions } from '../lib/queries';
import { timeAgo } from '../lib/format';
import type { AssetKind } from '../lib/types';
import Modal from './Modal';
import DiffList from './DiffList';

type Mode = 'introduced' | 'vs-current';

interface Props {
  kind: AssetKind;
  assetId: number;
  assetName: string;
  canEdit: boolean;
  onClose: () => void;
  /** Called after a restore created a new head version. */
  onRestored?: () => void;
}

export default function VersionHistory({ kind, assetId, assetName, canEdit, onClose, onRestored }: Props) {
  const versionsQuery = useVersions(kind, assetId);
  const versions = versionsQuery.data ?? [];
  // Selected by number, so it survives the list refetching (e.g. after a restore adds a version)
  const [selectedNo, setSelectedNo] = useState<number>();
  const [mode, setMode] = useState<Mode>('introduced');
  const [actionError, setActionError] = useState<string>();
  const [restoring, setRestoring] = useState(false);

  const selected = versions.find((v) => v.version_no === selectedNo) ?? versions[0];
  const head = versions.find((v) => v.is_head);
  const effectiveMode: Mode = selected?.is_head ? 'introduced' : mode;
  const diffRange: [number | undefined, number | undefined] = !selected || (effectiveMode === 'introduced' && selected.version_no === 1)
    ? [undefined, undefined]
    : effectiveMode === 'introduced' ? [selected.version_no - 1, selected.version_no] : [selected.version_no, head?.version_no];
  const diffQuery = useDiff(kind, assetId, diffRange[0], diffRange[1]);
  const diff = diffQuery.data;
  const error = actionError ?? versionsQuery.error?.message ?? diffQuery.error?.message;

  const restore = async () => {
    if (!selected || !confirm(`Restore v${selected.version_no}? This creates a new version with its content — nothing is deleted.`)) return;
    setRestoring(true);
    try {
      await api.restore(kind, assetId, selected.version_no);
      setSelectedNo(undefined);
      onRestored?.();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Modal xl title="Version history" subtitle={`${assetName} — every save is kept; restoring adds a new version.`} onClose={onClose}>
      <div className="flex h-[60vh] min-h-80 gap-5">
        <ol className="w-64 shrink-0 space-y-1.5 overflow-auto pr-1">
          {versions.map((v) => (
            <li key={v.id}>
              <button onClick={() => setSelectedNo(v.version_no)}
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                  selected?.id === v.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/40'
                }`}>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-ink">v{v.version_no}</span>
                  {v.is_head && <span className="rounded bg-accent px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white">Current</span>}
                  <span className="ml-auto text-[10px] text-ink-faint" title={new Date(v.created_at).toLocaleString()}>{timeAgo(v.created_at)}</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-ink-soft">{v.change_note || 'No note'}</span>
                <span className="block truncate text-[10px] text-ink-faint">by {v.created_by_name}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="flex min-w-0 flex-1 flex-col">
          {selected && (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-display text-base font-bold text-ink">v{selected.version_no} — {selected.name}</p>
                  <p className="text-xs text-ink-faint">
                    {selected.created_by_name} · {new Date(selected.created_at).toLocaleString()}
                  </p>
                </div>
                {canEdit && !selected.is_head && (
                  <button onClick={restore} disabled={restoring}
                    className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-bold text-white transition enabled:hover:bg-accent-deep disabled:opacity-50">
                    {restoring ? 'Restoring…' : `Restore v${selected.version_no}`}
                  </button>
                )}
              </div>
              {!selected.is_head && (
                <div className="mb-3 flex w-fit rounded-lg border border-line p-0.5">
                  {([['introduced', 'Changes in this version'], ['vs-current', `Compare with current (v${head?.version_no})`]] as [Mode, string][]).map(([m, text]) => (
                    <button key={m} onClick={() => setMode(m)}
                      className={`rounded-md px-3 py-1 text-xs font-semibold transition ${mode === m ? 'bg-accent text-white' : 'text-ink-soft hover:text-ink'}`}>
                      {text}
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto pr-1">
                {effectiveMode === 'introduced' && selected.version_no === 1 ? (
                  <p className="rounded-xl bg-canvas px-4 py-6 text-center text-sm text-ink-faint">Initial version.</p>
                ) : diff ? <DiffList diff={diff} /> : (
                  <div className="flex justify-center py-10"><div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" /></div>
                )}
              </div>
            </>
          )}
          {error && <p className="mt-2 text-sm text-negative">{error}</p>}
        </div>
      </div>
    </Modal>
  );
}
