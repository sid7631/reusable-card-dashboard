import { useState } from 'react';
import { api } from '../lib/api';
import { useRebasePreview } from '../lib/queries';
import { groupConflicts, showValue, type ConflictGroup } from '../lib/conflicts';
import type { AssetKind, Conflict } from '../lib/types';
import Modal from './Modal';
import DiffList from './DiffList';

type Side = 'ours' | 'theirs';

/** "Update from global": merge global changes into a private copy, choosing a side for each conflict. */
export default function RebaseDialog({ kind, assetId, onClose, onApplied }: {
  kind: AssetKind; assetId: number; onClose: () => void; onApplied: () => void;
}) {
  const previewQuery = useRebasePreview(kind, assetId);
  const preview = previewQuery.data;
  const [choices, setChoices] = useState<Record<string, Side>>({});
  const [actionError, setActionError] = useState<string>();
  const [applying, setApplying] = useState(false);
  const error = actionError ?? previewQuery.error?.message;

  const groups = preview ? groupConflicts(preview.conflicts) : [];
  const choiceOf = (g: ConflictGroup) => choices[g.paths[0]];
  const choose = (g: ConflictGroup, side: Side) => setChoices((ch) => ({ ...ch, ...Object.fromEntries(g.paths.map((p) => [p, side])) }));
  const chooseAll = (side: Side) => setChoices(Object.fromEntries(groups.flatMap((g) => g.paths.map((p) => [p, side]))));
  const unresolved = groups.filter((g) => !choiceOf(g)).length;

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
      subtitle={preview ? `Bring global v${preview.base_version} → v${preview.global_version} into your copy. Your other edits are kept.` : 'Loading…'}
      onClose={onClose}>
      {preview && (
        <div className="flex max-h-[65vh] flex-col gap-5 overflow-auto pr-1">
          {groups.length > 0 && (
            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-display text-sm font-bold text-negative">
                  {groups.length === 1 ? '1 decision' : `${groups.length} decisions`} — you and global both changed {groups.length === 1 ? 'this' : 'these'}
                </h3>
                <div className="flex gap-1.5">
                  <button onClick={() => chooseAll('ours')} className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft transition hover:border-accent/50 hover:text-ink">
                    Keep all mine
                  </button>
                  <button onClick={() => chooseAll('theirs')} className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft transition hover:border-accent/50 hover:text-ink">
                    Take all from global
                  </button>
                </div>
              </div>
              <ul className="space-y-3">
                {groups.map((g) => (
                  <li key={g.paths[0]} className={`rounded-xl border p-3 ${choiceOf(g) ? 'border-line' : 'border-negative/40'}`}>
                    <p className="mb-2 font-display text-sm font-bold text-ink">{g.label}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Choice side="ours" title="Keep mine" conflict={g.primary} selected={choiceOf(g) === 'ours'} onPick={() => choose(g, 'ours')} />
                      <Choice side="theirs" title={`Take global (v${preview.global_version})`} conflict={g.primary} selected={choiceOf(g) === 'theirs'} onPick={() => choose(g, 'theirs')} />
                    </div>
                    {g.linked.length > 0 && (
                      <p className="mt-2 text-[11px] text-ink-faint">
                        Also follows this choice: {g.linked.map((c) => `${c.path.replace(/^spec\.config\./, '')} (${showValue(c.ours)} vs ${showValue(c.theirs)})`).join(', ')} — the card's builder settings for the same query.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="mb-2 font-display text-sm font-bold text-ink">Changed in global since your copy</h3>
            <DiffList diff={{ from: preview.base_version, to: preview.global_version, changes: preview.incoming, labels: {} }} />
          </section>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-negative">{error}</p>}
      <div className="mt-5 flex items-center justify-end gap-3 border-t border-line pt-4">
        {unresolved > 0 && (
          <span className="text-xs font-medium text-negative">
            Choose “Keep mine” or “Take global” for {unresolved === 1 ? 'the conflict' : `each of the ${unresolved} conflicts`} above to continue.
          </span>
        )}
        <button onClick={apply} disabled={!preview || unresolved > 0 || applying}
          className="rounded-lg bg-accent px-5 py-2 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
          {applying ? 'Updating…' : 'Update my copy'}
        </button>
      </div>
    </Modal>
  );
}

/** One side of a conflict, as a radio-style button. SQL shows just the lines that side changed. */
function Choice({ side, title, conflict, selected, onPick }: {
  side: Side; title: string; conflict: Conflict; selected: boolean; onPick: () => void;
}) {
  const lines = side === 'ours' ? conflict.ours_lines : conflict.theirs_lines;
  const value = side === 'ours' ? conflict.ours : conflict.theirs;
  return (
    <button onClick={onPick} aria-pressed={selected}
      className={`flex flex-col rounded-lg border-2 p-2.5 text-left transition ${
        selected ? 'border-accent bg-accent-soft' : 'border-line bg-white hover:border-accent/50'}`}>
      <span className="flex items-center gap-2 text-xs font-bold text-ink">
        <span className={`flex size-4 items-center justify-center rounded-full border-2 ${selected ? 'border-accent' : 'border-line'}`}>
          {selected && <span className="size-2 rounded-full bg-accent" />}
        </span>
        {title}
      </span>
      {lines ? (
        <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-canvas p-2 font-mono text-[11px] leading-relaxed">
          {lines.filter((l) => !l.startsWith('@@')).map((line, i) => (
            <div key={i} className={line.startsWith('+') ? 'bg-positive/10 text-positive' : line.startsWith('-') ? 'bg-negative/10 text-negative' : 'text-ink-faint'}>
              {line || ' '}
            </div>
          ))}
        </pre>
      ) : (
        <span className="mt-1.5 break-all font-mono text-sm font-semibold text-ink">{showValue(value)}</span>
      )}
    </button>
  );
}
