import { useState } from 'react';
import { api } from '../lib/api';
import { useRebasePreview } from '../lib/queries';
import type { AssetKind } from '../lib/types';
import Modal from './Modal';
import DiffList from './DiffList';

function show(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 1);
}

/** "Update from global": merge global changes into a private copy, choosing a side for each conflict. */
export default function RebaseDialog({ kind, assetId, onClose, onApplied }: {
  kind: AssetKind; assetId: number; onClose: () => void; onApplied: () => void;
}) {
  const previewQuery = useRebasePreview(kind, assetId);
  const preview = previewQuery.data;
  const [choices, setChoices] = useState<Record<string, 'ours' | 'theirs'>>({});
  const [actionError, setActionError] = useState<string>();
  const [applying, setApplying] = useState(false);
  const error = actionError ?? previewQuery.error?.message;

  const unresolved = preview?.conflicts.filter((c) => !choices[c.path]).length ?? 0;

  const apply = async () => {
    setApplying(true);
    setActionError(undefined);
    try {
      await api.rebase(kind, assetId, choices);
      onApplied();
    } catch (e) {
      setActionError((e as Error).message);
      setApplying(false);
    }
  };

  return (
    <Modal xl title="Update from global"
      subtitle={preview ? `Bring global v${preview.base_version_no} → v${preview.global_version_no} into your copy. Your own edits are kept.` : 'Loading…'}
      onClose={onClose}>
      {preview && (
        <div className="flex max-h-[65vh] flex-col gap-5 overflow-auto pr-1">
          {preview.conflicts.length > 0 && (
            <section>
              <h3 className="mb-2 font-display text-sm font-bold text-negative">
                {preview.conflicts.length} conflict{preview.conflicts.length === 1 ? '' : 's'} — you and global both changed these
              </h3>
              <ul className="space-y-2.5">
                {preview.conflicts.map((c) => (
                  <li key={c.path} className="rounded-xl border border-negative/30 p-3">
                    <p className="mb-2 font-mono text-xs font-semibold text-ink">{c.path.replace(/^spec\./, '')}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {([['ours', 'Keep mine', c.ours], ['theirs', 'Take global', c.theirs]] as const).map(([side, label, value]) => (
                        <button key={side} onClick={() => setChoices((ch) => ({ ...ch, [c.path]: side }))}
                          className={`rounded-lg border p-2.5 text-left transition ${
                            choices[c.path] === side ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/40'
                          }`}>
                          <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-soft">{label}</span>
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink">{show(value)}</pre>
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="mb-2 font-display text-sm font-bold text-ink">Changed in global since your copy</h3>
            <DiffList diff={{ from: preview.base_version_no, to: preview.global_version_no, changes: preview.incoming, labels: {} }} />
          </section>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-negative">{error}</p>}
      <div className="mt-5 flex items-center justify-end gap-3 border-t border-line pt-4">
        {unresolved > 0 && <span className="text-xs text-ink-soft">{unresolved} conflict{unresolved === 1 ? '' : 's'} left to resolve</span>}
        <button onClick={apply} disabled={!preview || unresolved > 0 || applying}
          className="rounded-lg bg-accent px-5 py-2 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
          {applying ? 'Updating…' : 'Update my copy'}
        </button>
      </div>
    </Modal>
  );
}
