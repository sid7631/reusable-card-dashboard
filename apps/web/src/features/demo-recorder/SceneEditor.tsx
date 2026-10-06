import { useState } from 'react';
import { BlobImage, Dialog, ICONS, IconButton, btn, field, label } from './ui';
import { move } from './useRecording';
import { newId, type Motion, type Scene, type Shot } from './types';

const MOTIONS: [Motion, string][] = [['zoom-in', 'Zoom in'], ['zoom-out', 'Zoom out'], ['still', 'Still']];
const DURATIONS = [3000, 4000, 5000, 7000, 10000];

export type CaptureFn = (delayS: number) => Promise<Omit<Shot, 'id'> | null>;

/** Title, caption and images of one scene; edits a draft that is saved (or dropped) as a whole. */
export default function SceneEditor({ initial, isNew, number, capture, onSave, onDelete, onClose }: {
  initial: Scene;
  isNew: boolean;
  number: number;
  capture: CaptureFn;
  onSave: (scene: Scene) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [scene, setScene] = useState(initial);
  const [selected, setSelected] = useState(initial.shots[0]?.id);
  const shot = scene.shots.find((s) => s.id === selected) ?? scene.shots[0];
  const dirty = scene !== initial;

  const setShots = (fn: (shots: Shot[]) => Shot[]) => setScene((s) => ({ ...s, shots: fn(s.shots) }));
  const patchShot = (id: string, patch: Partial<Shot>) => setShots((shots) => shots.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const addShot = async (delayS: number) => {
    const captured = await capture(delayS);
    if (!captured) return;
    const id = newId();
    setShots((shots) => [...shots, { ...captured, id }]);
    setSelected(id);
  };
  const recapture = async (target: Shot) => {
    const captured = await capture(0);
    // Keep the motion settings the user chose; the image (and its size) is new
    if (captured) patchShot(target.id, { blob: captured.blob, width: captured.width, height: captured.height });
  };
  const close = () => { if (!dirty || confirm('Discard changes to this scene?')) onClose(); };

  return (
    <Dialog width="max-w-5xl" onClose={close}
      title={isNew ? `New scene ${number}` : `Edit scene ${number}`}
      subtitle="Each image plays in order with this scene's caption. Click the preview to set where the camera zooms."
      footer={<>
        {!isNew && <button type="button" className={`${btn.danger} mr-auto`} onClick={() => confirm('Delete this scene?') && onDelete()}>Delete scene</button>}
        <button type="button" className={btn.secondary} onClick={close}>Cancel</button>
        <button type="button" className={btn.primary} disabled={!scene.shots.length} onClick={() => onSave(scene)}>
          {isNew ? 'Add scene' : 'Save scene'}
        </button>
      </>}>
      <div className="grid gap-6 md:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          {shot ? (
            <>
              <FocusPreview shot={shot} onFocus={(focus) => patchShot(shot.id, { focus, motion: shot.motion === 'still' ? 'zoom-in' : shot.motion })} />
              <div className="mt-3 flex flex-wrap items-end gap-4">
                <div>
                  <span className={label}>Camera</span>
                  <div className="flex rounded-lg border border-line p-0.5">
                    {MOTIONS.map(([m, text]) => (
                      <button key={m} type="button" onClick={() => patchShot(shot.id, { motion: m })}
                        className={`rounded-md px-3 py-1 text-xs font-semibold transition ${shot.motion === m ? 'bg-accent text-white' : 'text-ink-soft hover:text-ink'}`}>
                        {text}
                      </button>
                    ))}
                  </div>
                </div>
                {shot.motion !== 'still' && (
                  <label className="block">
                    <span className={label}>Zoom {Math.round((shot.zoom - 1) * 100)}%</span>
                    <input type="range" min={1.05} max={1.8} step={0.05} value={shot.zoom} className="w-36 accent-[var(--color-accent)]"
                      onChange={(e) => patchShot(shot.id, { zoom: Number(e.target.value) })} />
                  </label>
                )}
                <label className="block">
                  <span className={label}>On screen</span>
                  <select value={shot.durationMs} onChange={(e) => patchShot(shot.id, { durationMs: Number(e.target.value) })}
                    className="rounded-lg border border-line px-2 py-1.5 text-sm outline-none focus:border-accent">
                    {DURATIONS.map((d) => <option key={d} value={d}>{d / 1000} s</option>)}
                  </select>
                </label>
              </div>
            </>
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-line text-sm text-ink-faint">
              No image yet — add one.
            </div>
          )}
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className={label}>Title</span>
            <input autoFocus aria-label="Scene title" value={scene.title} onChange={(e) => setScene((s) => ({ ...s, title: e.target.value }))}
              placeholder="e.g. Filter the dashboard by segment" className={field} />
          </label>
          <label className="block">
            <span className={label}>Caption</span>
            <textarea aria-label="Scene caption" value={scene.caption} rows={3} onChange={(e) => setScene((s) => ({ ...s, caption: e.target.value }))}
              placeholder="What the viewer should notice" className={`${field} resize-y`} />
          </label>

          <div>
            <span className={label}>Images ({scene.shots.length})</span>
            <ol className="space-y-1.5">
              {scene.shots.map((s, i) => (
                <li key={s.id} onClick={() => setSelected(s.id)}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border p-1.5 transition ${s.id === shot?.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/40'}`}>
                  <BlobImage blob={s.blob} className="h-10 w-16 shrink-0 rounded object-cover" />
                  <span className="min-w-0 flex-1 text-xs text-ink-soft">
                    <span className="font-semibold text-ink">#{i + 1}</span> · {s.durationMs / 1000} s · {MOTIONS.find(([m]) => m === s.motion)?.[1]}
                  </span>
                  <span className="flex" onClick={(e) => e.stopPropagation()}>
                    <IconButton label="Move up" disabled={i === 0} onClick={() => setShots((all) => move(all, i, i - 1))}>{ICONS.up}</IconButton>
                    <IconButton label="Move down" disabled={i === scene.shots.length - 1} onClick={() => setShots((all) => move(all, i, i + 1))}>{ICONS.down}</IconButton>
                    <IconButton label="Re-capture" onClick={() => recapture(s)}>{ICONS.recapture}</IconButton>
                    <IconButton label="Remove image" onClick={() => setShots((all) => all.filter((x) => x.id !== s.id))}>{ICONS.trash}</IconButton>
                  </span>
                </li>
              ))}
            </ol>
            <div className="mt-2 flex gap-2">
              <button type="button" className={`${btn.secondary} flex-1 !px-2 !py-1.5 !text-xs`} onClick={() => addShot(0)}>+ Add image</button>
              <button type="button" className={`${btn.secondary} !px-2 !py-1.5 !text-xs`} onClick={() => addShot(3)}
                title="Gives you 3 seconds to open a menu or hover before the capture">in 3 s</button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** The image with a marker for the zoom focus; click to move it. */
function FocusPreview({ shot, onFocus }: { shot: Shot; onFocus: (p: { x: number; y: number }) => void }) {
  return (
    <div className="flex justify-center rounded-xl border border-line bg-canvas p-2">
    {/* The box hugs the image, so click positions map exactly onto it */}
    <div className="relative overflow-hidden rounded-lg"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onFocus({ x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
      }}>
      <BlobImage blob={shot.blob} className="block max-h-[50vh] max-w-full cursor-crosshair" />
      {shot.motion !== 'still' && (
        <span className="pointer-events-none absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent/40 shadow-[0_0_0_2px_rgba(1,111,208,0.9)]"
          style={{ left: `${shot.focus.x * 100}%`, top: `${shot.focus.y * 100}%` }} />
      )}
      <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-ink/70 px-2 py-0.5 font-mono text-[10px] text-white">
        {shot.width} × {shot.height}
      </span>
    </div>
    </div>
  );
}
