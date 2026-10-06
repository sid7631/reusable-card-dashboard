import type { Recording } from './types';

/**
 * Recordings live in this browser's IndexedDB (images as Blobs), one per signed-in user, so a session
 * survives navigation, reloads and a re-login. Nothing is uploaded anywhere.
 */

const DB = 'spendboard-demo-recorder';
const STORE = 'recordings';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const loadRecording = (userKey: string) =>
  run<Recording | undefined>('readonly', (s) => s.get(userKey)).catch(() => undefined);

export const saveRecording = (userKey: string, recording: Recording) =>
  run('readwrite', (s) => s.put(recording, userKey)).then(() => undefined);

export const clearRecording = (userKey: string) =>
  run('readwrite', (s) => s.delete(userKey)).then(() => undefined).catch(() => undefined);
