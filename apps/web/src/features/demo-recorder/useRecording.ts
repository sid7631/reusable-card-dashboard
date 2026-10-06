import { useCallback, useEffect, useRef, useState } from 'react';
import { clearRecording, loadRecording, saveRecording } from './persist';
import type { Recording, Scene } from './types';

const EMPTY: Recording = { title: '', scenes: [], updatedAt: 0 };

/** The recording for one user, loaded from and saved (debounced) to IndexedDB. */
export function useRecording(userKey: string) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    let alive = true;
    loadRecording(userKey).then((found) => {
      if (!alive) return;
      const r = found ?? { ...EMPTY, updatedAt: Date.now() };
      // Stored from the start, so even a session with no scenes yet survives a reload
      if (!found) saveRecording(userKey, r).catch(console.error);
      setRecording(r);
    });
    return () => { alive = false; };
  }, [userKey]);

  useEffect(() => {
    if (!recording || !dirty.current) return;
    const t = setTimeout(() => { saveRecording(userKey, recording).catch(console.error); }, 300);
    return () => clearTimeout(t);
  }, [recording, userKey]);

  const update = useCallback((fn: (r: Recording) => Recording) => {
    dirty.current = true;
    setRecording((r) => (r ? { ...fn(r), updatedAt: Date.now() } : r));
  }, []);

  const actions = {
    saveScene: (scene: Scene) => update((r) => {
      const i = r.scenes.findIndex((s) => s.id === scene.id);
      return { ...r, scenes: i < 0 ? [...r.scenes, scene] : r.scenes.map((s) => (s.id === scene.id ? scene : s)) };
    }),
    removeScene: (id: string) => update((r) => ({ ...r, scenes: r.scenes.filter((s) => s.id !== id) })),
    moveScene: (from: number, to: number) => update((r) => ({ ...r, scenes: move(r.scenes, from, to) })),
    setTitle: (title: string) => update((r) => ({ ...r, title })),
    /** Ends the session: deletes the stored recording. */
    discard: () => { dirty.current = false; return clearRecording(userKey); },
  };

  return { recording, ...actions };
}

export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
