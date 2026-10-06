/**
 * Screen capture through the browser's Screen Capture API: one permission prompt per recording session
 * (Chrome / Edge offer "this tab" first), then pixel-exact frames on demand. The recorder hides its own
 * UI, waits for a frame painted after that, and grabs it — so the bar never appears in a shot.
 */

export class CaptureUnsupported extends Error {}

export class ScreenSource {
  private constructor(private stream: MediaStream, private video: HTMLVideoElement) {}

  static async start(): Promise<ScreenSource> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new CaptureUnsupported('This browser cannot capture the screen — use a desktop Chrome, Edge, Firefox or Safari.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 15 }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
      // Not yet in TypeScript's DOM types: offer the current tab first, and keep the choice fixed
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    // Kept in the document (but invisible): some browsers stop decoding detached videos
    Object.assign(video.style, { position: 'fixed', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', left: '0', top: '0' });
    video.setAttribute('aria-hidden', 'true');
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();
    await firstFrame(video);
    return new ScreenSource(stream, video);
  }

  get active(): boolean {
    return this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /** "browser" when the user shared a tab; "window" / "monitor" otherwise. */
  get surface(): string | undefined {
    return (this.stream.getVideoTracks()[0]?.getSettings() as { displaySurface?: string }).displaySurface;
  }

  onEnded(fn: () => void): void {
    this.stream.getVideoTracks().forEach((t) => t.addEventListener('ended', fn));
  }

  /** A frame painted after the caller hid the recorder UI. */
  async grab(): Promise<HTMLCanvasElement> {
    await nextVideoFrame(this.video);
    await nextVideoFrame(this.video);
    if (this.video.videoWidth < 16 || !this.active) throw new Error('The shared screen sent no picture — start sharing again.');
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    canvas.getContext('2d')!.drawImage(this.video, 0, 0);
    return canvas;
  }

  stop(): void {
    this.stream.getTracks().forEach((t) => t.stop());
    this.video.remove();
  }
}

function firstFrame(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); video.removeEventListener('resize', done); resolve(); };
    const timer = setTimeout(done, 3000);
    video.addEventListener('resize', done);
  });
}

function nextVideoFrame(video: HTMLVideoElement, timeoutMs = 400): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);   // a static page may send no new frame — the last one is current
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
  });
}

/** Two paints, so DOM changes (e.g. hiding the recorder) reach the screen before a capture. Browsers pause
 * animation frames in background tabs, so a timeout guarantees this never hangs. */
export const afterPaint = () => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 250);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
});

export interface Rect { x: number; y: number; w: number; h: number }

const MAX_WIDTH = 2560;

/** Crop a region (frame pixels) and encode it compactly: WebP where supported, else JPEG. */
export async function cropToBlob(frame: HTMLCanvasElement, rect: Rect): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, MAX_WIDTH / rect.w);
  const width = Math.max(1, Math.round(rect.w * scale));
  const height = Math.max(1, Math.round(rect.h * scale));
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height);
  const encode = (type: string) => new Promise<Blob | null>((r) => out.toBlob(r, type, 0.9));
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  if (!blob) throw new Error('Could not encode the capture.');
  return { blob, width, height };
}
