import { useEffect, useRef, useState } from 'react';
import type { Rect } from './capture';

/**
 * Shows the frozen capture full-screen; the user drags a rectangle (or keeps the whole screen).
 * Works on the captured image itself, so it is exact whatever was shared (tab, window or screen).
 */
export default function RegionSelect({ frame, onDone, onCancel }: {
  frame: HTMLCanvasElement;
  onDone: (rect: Rect) => void;
  onCancel: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<DOMRect>();
  const [sel, setSel] = useState<{ x0: number; y0: number; x1: number; y1: number }>();
  const [dragging, setDragging] = useState(false);

  // Show the frame contained in the viewport
  useEffect(() => {
    const el = host.current!;
    frame.className = 'block max-h-full max-w-full select-none shadow-2xl';
    el.appendChild(frame);
    const measure = () => setBox(frame.getBoundingClientRect());
    measure();
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); frame.remove(); };
  }, [frame]);

  const full = () => onDone({ x: 0, y: 0, w: frame.width, h: frame.height });

  const confirm = () => {
    if (!sel || !box) return full();
    const k = frame.width / box.width;
    const x = Math.min(sel.x0, sel.x1), y = Math.min(sel.y0, sel.y1);
    const w = Math.abs(sel.x1 - sel.x0), h = Math.abs(sel.y1 - sel.y0);
    onDone({ x: Math.round(x * k), y: Math.round(y * k), w: Math.round(w * k), h: Math.round(h * k) });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();   // capture phase on window: the app's own Escape handlers never see it
      if (e.key === 'Escape') onCancel(); else confirm();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const local = (e: React.PointerEvent) => {
    const b = box!;
    return { x: Math.max(0, Math.min(b.width, e.clientX - b.left)), y: Math.max(0, Math.min(b.height, e.clientY - b.top)) };
  };
  const tooSmall = sel && (Math.abs(sel.x1 - sel.x0) < 12 || Math.abs(sel.y1 - sel.y0) < 12);
  const rect = sel && !tooSmall && box ? {
    left: box.left + Math.min(sel.x0, sel.x1), top: box.top + Math.min(sel.y0, sel.y1),
    width: Math.abs(sel.x1 - sel.x0), height: Math.abs(sel.y1 - sel.y0),
  } : null;

  return (
    <div className="fixed inset-0 z-[2147483002] cursor-crosshair select-none bg-[#050b1a]"
      onPointerDown={(e) => {
        if (!box || (e.target as HTMLElement).closest('[data-toolbar]')) return;
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not an active pointer (e.g. synthetic) */ }
        const p = local(e);
        setSel({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        setDragging(true);
      }}
      onPointerMove={(e) => { if (dragging) { const p = local(e); setSel((s) => s && { ...s, x1: p.x, y1: p.y }); } }}
      onPointerUp={() => { setDragging(false); if (tooSmall) setSel(undefined); }}>
      <div ref={host} className="absolute inset-0 flex items-center justify-center p-6" />
      {/* Dim everything outside the selection */}
      {rect ? (
        <div className="pointer-events-none fixed rounded-sm border-2 border-white shadow-[0_0_0_9999px_rgba(5,11,26,0.6)]" style={rect}>
          <span className="absolute -top-7 left-0 rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink">
            {Math.round(rect.width * (frame.width / (box?.width || 1)))} × {Math.round(rect.height * (frame.width / (box?.width || 1)))}
          </span>
        </div>
      ) : <div className="pointer-events-none absolute inset-0 bg-[#050b1a]/25" />}

      <div data-toolbar className="fixed left-1/2 top-5 flex -translate-x-1/2 cursor-default items-center gap-2 rounded-2xl bg-white/95 p-2 pl-4 shadow-2xl">
        <span className="mr-2 text-sm text-ink-soft">{rect ? 'Selection ready' : 'Drag to select an area — or use the whole screen'}</span>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-ink-soft hover:bg-canvas">Cancel</button>
        <button type="button" onClick={full} className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:border-accent/50">Whole screen</button>
        <button type="button" onClick={confirm} disabled={!rect}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white enabled:hover:bg-accent-deep disabled:opacity-40">Use selection ↵</button>
      </div>
    </div>
  );
}
