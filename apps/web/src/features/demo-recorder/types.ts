/** A recording: an ordered list of scenes, each with one or more captured images ("shots"). */

export type Motion = 'zoom-in' | 'zoom-out' | 'still';

export interface Shot {
  id: string;
  blob: Blob;
  width: number;
  height: number;
  /** Camera move played over this image in the reel. */
  motion: Motion;
  /** Point the zoom moves toward (0–1 of width / height). */
  focus: { x: number; y: number };
  /** Zoom at the close end of the move, e.g. 1.15. */
  zoom: number;
  durationMs: number;
}

export interface Scene {
  id: string;
  title: string;
  caption: string;
  shots: Shot[];
}

export interface Recording {
  title: string;
  scenes: Scene[];
  updatedAt: number;
}

export const DEFAULT_SHOT = { motion: 'zoom-in' as Motion, focus: { x: 0.5, y: 0.5 }, zoom: 1.15, durationMs: 5000 };

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
