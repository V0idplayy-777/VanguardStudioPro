/*
  IndexedDB persistence for imported media blobs and the autosaved project, so
  a page reload restores the session without re-importing.
*/

const DB_NAME = 'vanguard-studio-pro';
const DB_VERSION = 1;
const STORE_MEDIA = 'media';
const STORE_PROJECT = 'project';
const STORE_KV = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MEDIA)) db.createObjectStore(STORE_MEDIA);
      if (!db.objectStoreNames.contains(STORE_PROJECT)) db.createObjectStore(STORE_PROJECT);
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function persistMediaBlob(assetId: string, blob: Blob) {
  try {
    await tx(STORE_MEDIA, 'readwrite', (s) => s.put({ blob, name: (blob as File).name ?? '', type: blob.type }, assetId));
  } catch (e) {
    console.warn('persistMediaBlob failed', e);
  }
}

export async function loadMediaBlob(assetId: string): Promise<Blob | null> {
  try {
    const r = await tx<any>(STORE_MEDIA, 'readonly', (s) => s.get(assetId));
    if (!r) return null;
    const b: Blob = r.blob;
    if (r.name && typeof File !== 'undefined') return new File([b], r.name, { type: r.type || b.type });
    return b;
  } catch {
    return null;
  }
}

export async function deleteMediaBlob(assetId: string) {
  try {
    await tx(STORE_MEDIA, 'readwrite', (s) => s.delete(assetId));
  } catch {
    /* ignore */
  }
}

export async function listMediaKeys(): Promise<string[]> {
  try {
    const keys = await tx<IDBValidKey[]>(STORE_MEDIA, 'readonly', (s) => s.getAllKeys());
    return keys.map(String);
  } catch {
    return [];
  }
}

export async function saveProjectAutosave(json: string) {
  try {
    await tx(STORE_PROJECT, 'readwrite', (s) => s.put({ json, at: Date.now() }, 'autosave'));
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

export async function loadProjectAutosave(): Promise<{ json: string; at: number } | null> {
  try {
    return (await tx<any>(STORE_PROJECT, 'readonly', (s) => s.get('autosave'))) ?? null;
  } catch {
    return null;
  }
}

export async function clearProjectAutosave() {
  try {
    await tx(STORE_PROJECT, 'readwrite', (s) => s.delete('autosave'));
  } catch {
    /* ignore */
  }
}

export async function kvSet(key: string, value: any) {
  try {
    await tx(STORE_KV, 'readwrite', (s) => s.put(value, key));
  } catch {
    /* ignore */
  }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return await tx<T>(STORE_KV, 'readonly', (s) => s.get(key));
  } catch {
    return undefined;
  }
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}
