import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUnsupported, ScreenSource, afterPaint, cropToBlob, type Rect } from './capture';
import FinishDialog from './FinishDialog';
import RegionSelect from './RegionSelect';
import SceneEditor, { type CaptureFn } from './SceneEditor';
import SceneList from './SceneList';
import { DEFAULT_SHOT, newId, type Scene } from './types';
import { useRecording } from './useRecording';

/**
 * A recording session: the floating bar, the capture flow and the scene editing UI. Everything renders
 * into one container on <body>, which is hidden while a frame is grabbed — so none of it is ever in a shot.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'countdown'; n: number }
  | { kind: 'grabbing' }
  | { kind: 'selecting'; frame: HTMLCanvasElement };

type Editing = { scene: Scene; isNew: boolean; number: number } | null;

const BAR_POS_KEY = 'sb-demo-recorder-bar';

export default function RecorderSession({ userKey, author, onEnded }: { userKey: string; author: string; onEnded: () => void }) {
  const { recording, saveScene, removeScene, moveScene, setTitle, discard } = useRecording(userKey);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [panel, setPanel] = useState<'none' | 'scenes' | 'finish'>('none');
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string>();
  const source = useRef<ScreenSource | null>(null);
  const pending = useRef<((rect: Rect | null) => void) | null>(null);

  // Our own container on <body>, above everything the app renders
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.dataset.demoRecorder = '';
    return el;
  });
  useEffect(() => {
    document.body.appendChild(host);
    // React has already attached its listeners to this portal container; these run after them and stop
    // the event there, so the app's window-level handlers (closing an open filter menu or dialog on an
    // outside click / Escape) never react to the recorder — the screen stays as the user set it up.
    const stop = (e: Event) => e.stopPropagation();
    const events = ['mousedown', 'pointerdown', 'keydown', 'click'];
    events.forEach((t) => host.addEventListener(t, stop));
    return () => { events.forEach((t) => host.removeEventListener(t, stop)); host.remove(); };
  }, [host]);

  useEffect(() => () => source.current?.stop(), []);

  /** Grab a frame (after an optional countdown), let the user pick a region, return the encoded shot. */
  const capture: CaptureFn = useCallback(async (delayS) => {
    try {
      if (!source.current?.active) {
        source.current?.stop();
        source.current = await ScreenSource.start();   // first await: still inside the click, as the browser requires
        source.current.onEnded(() => { source.current = null; });
        if (source.current.surface && source.current.surface !== 'browser') {
          setNotice('You shared a window or screen rather than this tab — captures show whatever is visible there.');
        }
      }
      for (let n = delayS; n > 0; n--) {
        setPhase({ kind: 'countdown', n });
        await new Promise((r) => setTimeout(r, 1000));
      }
      setPhase({ kind: 'grabbing' });
      await afterPaint();
      const frame = await source.current.grab();
      const rect = await new Promise<Rect | null>((resolve) => {
        pending.current = resolve;
        setPhase({ kind: 'selecting', frame });
      });
      if (!rect) return null;
      const { blob, width, height } = await cropToBlob(frame, rect);
      return { ...DEFAULT_SHOT, blob, width, height };
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') setNotice(err instanceof CaptureUnsupported ? err.message : `Capture failed: ${err.message}`);
      else setNotice('Screen sharing was not allowed — the recorder needs it to capture scenes.');
      return null;
    } finally {
      pending.current = null;
      setPhase({ kind: 'idle' });
    }
  }, []);

  const captureScene = async (delayS: number) => {
    setPanel('none');
    const shot = await capture(delayS);
    if (shot && recording) {
      setEditing({ scene: { id: newId(), title: '', caption: '', shots: [{ ...shot, id: newId() }] }, isNew: true, number: recording.scenes.length + 1 });
    }
  };

  const end = async () => {
    source.current?.stop();
    source.current = null;
    await discard();
    onEnded();
  };

  if (!recording) return null;
  const hidden = phase.kind === 'grabbing' || phase.kind === 'selecting';
  const shotCount = recording.scenes.reduce((n, s) => n + s.shots.length, 0);

  return createPortal(
    <>
      <div style={{ visibility: hidden ? 'hidden' : 'visible' }}>
        <Bar
          scenes={recording.scenes.length}
          shots={shotCount}
          busy={phase.kind !== 'idle' || editing !== null}
          onCapture={() => captureScene(0)}
          onCaptureDelayed={() => captureScene(3)}
          onScenes={() => setPanel((p) => (p === 'scenes' ? 'none' : 'scenes'))}
          onFinish={() => setPanel('finish')}
          onDiscard={() => {
            if (!recording.scenes.length || confirm(`Discard this recording and its ${recording.scenes.length} scene(s)?`)) end();
          }}
        />

        {phase.kind === 'countdown' && (
          <div className="pointer-events-none fixed left-1/2 top-1/2 z-[2147483003] flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent-deep/80 font-display text-5xl font-extrabold text-white shadow-2xl">
            {phase.n}
          </div>
        )}

        {notice && (
          <div role="status" className="fixed left-1/2 top-4 z-[2147483003] flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-xl">
            <span className="flex-1">{notice}</span>
            <button type="button" className="font-semibold" onClick={() => setNotice(undefined)}>OK</button>
          </div>
        )}

        {panel === 'scenes' && (
          <SceneList
            scenes={recording.scenes}
            onEdit={(i) => setEditing({ scene: recording.scenes[i], isNew: false, number: i + 1 })}
            onMove={moveScene}
            onDelete={(i) => removeScene(recording.scenes[i].id)}
            onCapture={() => captureScene(0)}
            onFinish={() => setPanel('finish')}
            onClose={() => setPanel('none')}
          />
        )}

        {editing && (
          <SceneEditor
            key={editing.scene.id}
            initial={editing.scene}
            isNew={editing.isNew}
            number={editing.number}
            capture={capture}
            onSave={(scene) => { saveScene(scene); setEditing(null); }}
            onDelete={() => { removeScene(editing.scene.id); setEditing(null); }}
            onClose={() => setEditing(null)}
          />
        )}

        {panel === 'finish' && (
          <FinishDialog recording={recording} author={author} onTitle={setTitle} onEnd={end} onClose={() => setPanel('none')} />
        )}
      </div>

      {phase.kind === 'selecting' && (
        <RegionSelect frame={phase.frame} onDone={(rect) => pending.current?.(rect)} onCancel={() => pending.current?.(null)} />
      )}
    </>,
    host,
  );
}

/** The floating recorder bar — draggable by its grip; position remembered in this browser. */
function Bar({ scenes, shots, busy, onCapture, onCaptureDelayed, onScenes, onFinish, onDiscard }: {
  scenes: number; shots: number; busy: boolean;
  onCapture: () => void; onCaptureDelayed: () => void; onScenes: () => void; onFinish: () => void; onDiscard: () => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem(BAR_POS_KEY) ?? 'null'); } catch { return null; }
  });
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const clampToViewport = useCallback((p: { x: number; y: number }) => {
    const r = ref.current?.getBoundingClientRect();
    const w = r?.width ?? 400, h = r?.height ?? 52;
    return { x: Math.max(8, Math.min(window.innerWidth - w - 8, p.x)), y: Math.max(8, Math.min(window.innerHeight - h - 8, p.y)) };
  }, []);
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampToViewport(p) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampToViewport]);

  // Buttons don't take focus: an open menu or field in the app stays as it is for the capture
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const button = 'flex items-center gap-1.5 rounded-xl px-3 py-2 font-display text-sm font-semibold transition disabled:opacity-40';

  return (
    <div ref={ref} role="toolbar" aria-label="Demo recorder"
      className="fixed z-[2147483000] flex items-center gap-1 rounded-2xl border border-white/10 bg-accent-deep/95 p-1.5 text-white shadow-[0_18px_50px_-12px_rgba(0,23,90,0.7)] backdrop-blur"
      style={pos ? { left: pos.x, top: pos.y } : { left: '50%', bottom: 20, transform: 'translateX(-50%)' }}>
      <span className="cursor-grab touch-none px-1.5 text-sky-200/60 active:cursor-grabbing" title="Drag to move"
        onPointerDown={(e) => {
          const r = ref.current!.getBoundingClientRect();
          drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
          try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not an active pointer */ }
        }}
        onPointerMove={(e) => { if (drag.current) setPos(clampToViewport({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy })); }}
        onPointerUp={() => { drag.current = null; setPos((p) => { if (p) localStorage.setItem(BAR_POS_KEY, JSON.stringify(p)); return p; }); }}>
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2" cy="3" r="1.3" /><circle cx="8" cy="3" r="1.3" /><circle cx="2" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="2" cy="13" r="1.3" /><circle cx="8" cy="13" r="1.3" /></svg>
      </span>
      <span className="mr-1 flex items-center gap-2 pr-2 text-xs font-semibold">
        <span className="relative flex size-2.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-red-500" /></span>
        <span className="whitespace-nowrap">Recording · {scenes} scene{scenes === 1 ? '' : 's'}{shots > scenes ? ` · ${shots} images` : ''}</span>
      </span>
      <button type="button" onMouseDown={keepFocus} onClick={onCapture} disabled={busy} className={`${button} bg-accent hover:bg-[#1b84e2]`}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M2 5.5A1.5 1.5 0 013.5 4h1.6l1-1.5h3.8l1 1.5h1.6A1.5 1.5 0 0114 5.5v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" /><circle cx="8" cy="8.5" r="2.4" /></svg>
        Capture scene
      </button>
      <button type="button" onMouseDown={keepFocus} onClick={onCaptureDelayed} disabled={busy} className={`${button} px-2 text-sky-100 hover:bg-white/10`}
        title="Capture in 3 seconds — time to open a menu or hover over something">3 s</button>
      <span className="mx-1 h-6 w-px bg-white/15" />
      <button type="button" onMouseDown={keepFocus} onClick={onScenes} disabled={busy} className={`${button} text-sky-100 hover:bg-white/10`}>Scenes</button>
      <button type="button" onMouseDown={keepFocus} onClick={onFinish} disabled={busy || !scenes} className={`${button} text-sky-100 hover:bg-white/10`}>Finish</button>
      <button type="button" onMouseDown={keepFocus} onClick={onDiscard} disabled={busy} aria-label="Discard recording" title="Discard recording"
        className="rounded-xl p-2 text-sky-200/70 transition hover:bg-white/10 hover:text-white disabled:opacity-40">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
      </button>
    </div>
  );
}
