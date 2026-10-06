import { useState } from 'react';
import { buildReel, download, reelFilename } from './exportReel';
import { Dialog, btn, field, label } from './ui';
import type { Recording } from './types';

/** Name the reel, preview it, download the self-contained HTML — then end the session or keep editing. */
export default function FinishDialog({ recording, author, onTitle, onEnd, onClose }: {
  recording: Recording;
  author: string;
  onTitle: (title: string) => void;
  onEnd: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(recording.title || 'SpendBoard walkthrough');
  const [titleCard, setTitleCard] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [downloaded, setDownloaded] = useState<{ name: string; size: number }>();

  const shots = recording.scenes.reduce((n, s) => n + s.shots.length, 0);
  const seconds = Math.round(recording.scenes.reduce((t, s) => t + s.shots.reduce((u, h) => u + h.durationMs, 0), 0) / 1000) + (titleCard ? 4 : 0);
  const subtitle = `${author} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;

  const build = async () => {
    onTitle(title);
    return buildReel({ ...recording, title }, { title, titleCard, subtitle });
  };

  const preview = async () => {
    const tab = window.open('', '_blank');   // opened during the click, so it isn't blocked as a pop-up
    setBusy(true);
    setError(undefined);
    try {
      const url = URL.createObjectURL(await build());
      if (tab) tab.location.href = url; else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const blob = await build();
      const name = reelFilename(title);
      download(blob, name);
      setDownloaded({ name, size: blob.size });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (downloaded) {
    return (
      <Dialog title="Reel downloaded" onClose={onClose}
        subtitle={`${downloaded.name} · ${(downloaded.size / 1024 / 1024).toFixed(1)} MB — one file, opens in any browser, works offline.`}
        footer={<>
          <button type="button" className={btn.secondary} onClick={onClose}>Keep editing</button>
          <button type="button" className={btn.primary} onClick={() => confirm('End the recording? Its scenes will be deleted from this browser.') && onEnd()}>
            End recording
          </button>
        </>}>
        <p className="text-sm text-ink-soft">
          Keep editing to adjust scenes and download again, or end the recording to clear it from this browser.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog title="Finish demo reel" onClose={onClose}
      subtitle={`${recording.scenes.length} scenes · ${shots} images · about ${seconds} s`}
      footer={<>
        <button type="button" className={`${btn.secondary} mr-auto`} onClick={onClose}>Back</button>
        <button type="button" className={btn.secondary} disabled={busy} onClick={preview}>Preview</button>
        <button type="button" className={btn.primary} disabled={busy || !title.trim()} onClick={save}>
          {busy ? 'Building…' : 'Download HTML'}
        </button>
      </>}>
      <div className="space-y-4">
        <label className="block">
          <span className={label}>Reel title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={titleCard} onChange={(e) => setTitleCard(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          Open with a title card <span className="text-ink-faint">({subtitle})</span>
        </label>
        <p className="rounded-lg bg-canvas px-3 py-2.5 text-xs leading-relaxed text-ink-soft">
          The reel plays like a slide show: scenes advance on their own with a slow zoom, captions on top.
          Viewers can pause (space), step with ← →, jump on the progress bar and go full screen (F).
        </p>
        {error && <p className="text-sm text-negative">{error}</p>}
      </div>
    </Dialog>
  );
}
