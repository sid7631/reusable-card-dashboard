import playerCss from './player/reel.css?raw';
import playerJs from './player/reel.js?raw';
import type { Recording, Shot } from './types';

/**
 * Builds the reel: ONE self-contained HTML file — images embedded as data URIs, the player's CSS and
 * JS inline, no network access — that plays offline from a laptop, a share or an email attachment.
 */

type View = { s: number; x: number; y: number };

const WIDE: View = { s: 1, x: 0.5, y: 0.5 };

/** The two camera positions a shot moves between. */
function views(shot: Shot): { from: View; to: View } {
  const close: View = { s: shot.zoom, x: shot.focus.x, y: shot.focus.y };
  if (shot.motion === 'zoom-in') return { from: WIDE, to: close };
  if (shot.motion === 'zoom-out') return { from: close, to: WIDE };
  return { from: WIDE, to: WIDE };
}

const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Inlined CSS / JS must not contain their own closing tag (a comment mentioning it would end the element)
const inlineSafe = (code: string, tag: 'style' | 'script') => code.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
// JSON inside <script>: neutralise anything that could end or confuse the element
const scriptSafe = (json: string) => json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export interface ReelOptions {
  title: string;
  titleCard: boolean;
  /** Shown on the title card, e.g. the date. */
  subtitle: string;
}

export async function buildReel(recording: Recording, options: ReelOptions): Promise<Blob> {
  const scenes = [];
  for (const scene of recording.scenes) {
    const shots = [];
    for (const shot of scene.shots) {
      shots.push({ src: await toDataUrl(shot.blob), w: shot.width, h: shot.height, ms: shot.durationMs, ...views(shot) });
    }
    scenes.push({ title: scene.title, caption: scene.caption, shots });
  }
  const data = { title: options.title, subtitle: options.subtitle, titleCard: options.titleCard, scenes };
  const title = escapeHtml(options.title || 'Demo');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="SpendBoard demo recorder">
<title>${title}</title>
<style>${inlineSafe(playerCss, 'style')}</style>
</head>
<body>
<div id="reel">
  <div id="stage" aria-live="polite">
    <div id="titlecard" class="titlecard"><div class="kicker">Walkthrough</div><h1>${title}</h1><p>${escapeHtml(options.subtitle)} · ${scenes.length} scene${scenes.length === 1 ? '' : 's'}</p></div>
    <div id="caption" class="caption"><div class="step"></div><h2></h2><p></p></div>
    <button id="replay" type="button"><svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 11-5 5H5a7 7 0 107-7z"/></svg>Replay</button>
  </div>
  <div id="bar">
    <button id="prev" type="button" aria-label="Previous (←)"></button>
    <button id="play" type="button" aria-label="Play"></button>
    <button id="next" type="button" aria-label="Next (→)"></button>
    <div id="track" role="slider" aria-label="Progress — click to jump"></div>
    <span id="label"></span>
    <button id="full" type="button" aria-label="Full screen"></button>
  </div>
</div>
<script id="reel-data" type="application/json">${scriptSafe(JSON.stringify(data))}</script>
<script>${inlineSafe(playerJs, 'script')}</script>
</body>
</html>`;
  return new Blob([html], { type: 'text/html' });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const reelFilename = (title: string) =>
  `${(title || 'demo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'demo'}.html`;
