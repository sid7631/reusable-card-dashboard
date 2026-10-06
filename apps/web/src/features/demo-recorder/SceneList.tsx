import { useState } from 'react';
import { BlobImage, ICONS, IconButton, btn } from './ui';
import type { Scene } from './types';

/** Side panel: the ordered scenes — reorder (drag or arrows), edit, delete. */
export default function SceneList({ scenes, onEdit, onMove, onDelete, onCapture, onFinish, onClose }: {
  scenes: Scene[];
  onEdit: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onDelete: (index: number) => void;
  onCapture: () => void;
  onFinish: () => void;
  onClose: () => void;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const totalMs = scenes.reduce((t, s) => t + s.shots.reduce((u, h) => u + h.durationMs, 0), 0);

  return (
    <>
      <div className="fixed inset-0 z-[2147482999] bg-accent-deep/25" onMouseDown={onClose} />
      <aside className="fixed inset-y-0 right-0 z-[2147483000] flex w-[400px] max-w-full flex-col bg-white shadow-2xl"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-ink">Scenes</h2>
            <p className="text-xs text-ink-soft">
              {scenes.length} scene{scenes.length === 1 ? '' : 's'} · about {Math.round(totalMs / 1000)} s of reel · drag to reorder
            </p>
          </div>
          <IconButton label="Close" onClick={onClose}><path d="M3 3l10 10M13 3L3 13" /></IconButton>
        </div>

        <ol className="flex-1 space-y-2 overflow-auto p-4">
          {scenes.map((scene, i) => (
            <li key={scene.id} draggable
              onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
              onDragOver={(e) => { if (dragFrom !== null) { e.preventDefault(); setDragOver(i); } }}
              onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
              onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) onMove(dragFrom, i); setDragFrom(null); setDragOver(null); }}
              onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
              className={`group flex gap-3 rounded-xl border bg-white p-2.5 transition ${
                dragOver === i && dragFrom !== i ? 'border-accent ring-2 ring-accent/20' : 'border-line hover:border-accent/40'
              } ${dragFrom === i ? 'opacity-40' : ''}`}>
              <div className="relative shrink-0 cursor-grab active:cursor-grabbing">
                {scene.shots[0] && <BlobImage blob={scene.shots[0].blob} className="h-16 w-24 rounded-md object-cover" />}
                {scene.shots.length > 1 && (
                  <span className="absolute bottom-1 right-1 rounded bg-ink/75 px-1 text-[10px] font-bold text-white">×{scene.shots.length}</span>
                )}
              </div>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onEdit(i)}>
                <p className="truncate font-display text-sm font-bold text-ink">
                  <span className="text-ink-faint">{i + 1}.</span> {scene.title || 'Untitled scene'}
                </p>
                <p className="line-clamp-2 text-xs text-ink-soft">{scene.caption || 'No caption'}</p>
              </button>
              <div className="flex shrink-0 flex-col">
                <IconButton label="Edit" onClick={() => onEdit(i)}>{ICONS.edit}</IconButton>
                <IconButton label="Move up" disabled={i === 0} onClick={() => onMove(i, i - 1)}>{ICONS.up}</IconButton>
                <IconButton label="Move down" disabled={i === scenes.length - 1} onClick={() => onMove(i, i + 1)}>{ICONS.down}</IconButton>
                <IconButton label="Delete" onClick={() => confirm(`Delete scene ${i + 1}?`) && onDelete(i)}>{ICONS.trash}</IconButton>
              </div>
            </li>
          ))}
          {!scenes.length && (
            <li className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-ink-faint">
              No scenes yet. Go to the screen you want to show and press <b>Capture scene</b>.
            </li>
          )}
        </ol>

        <div className="flex gap-2 border-t border-line p-4">
          <button type="button" className={`${btn.secondary} flex-1`} onClick={onCapture}>Capture scene</button>
          <button type="button" className={`${btn.primary} flex-1`} disabled={!scenes.length} onClick={onFinish}>Finish…</button>
        </div>
      </aside>
    </>
  );
}
