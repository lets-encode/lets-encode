// The page images of a campaign setup in progress, kept in the browser's
// IndexedDB under the campaign's name until the setup's last step commits them
// to the new repository. A draft record (wizard-draft.ts) lives in localStorage,
// which holds text only; IndexedDB stores the image blobs themselves.
//
// Like localStorage, IndexedDB belongs to one browser on one device, and a
// browser may clear it: Safari does so for a site not visited for seven days of
// use, and any browser may under storage pressure. A setup whose images are gone
// is continued from the upload step.

import type { PageImage } from "./prepare-images.ts";

const DB_NAME = "lets-encode-setup";
const STORE = "images";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this browser offers no IndexedDB"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB could not be opened"));
  });
}

/** Run one request in its own transaction and resolve once that commits. */
async function inStore<T>(
  mode: IDBTransactionMode,
  make: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = make(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? request.error ?? new Error("IndexedDB failed"));
    });
  } finally {
    db.close();
  }
}

/**
 * Store a setup's page images under its name, replacing any stored before.
 * Returns the browser's message when it refused the write, null when stored.
 */
export async function storeDraftImages(
  handle: string,
  images: PageImage[],
): Promise<string | null> {
  try {
    await inStore("readwrite", (store) =>
      store.put(
        images.map(({ path, blob }) => ({ path, blob })),
        handle,
      ),
    );
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * The page images stored for a setup, in the order of `paths`, when every one
 * of them is there; null when any is missing or the store cannot be read.
 */
export async function readDraftImages(
  handle: string,
  paths: string[],
): Promise<PageImage[] | null> {
  try {
    const stored = await inStore<PageImage[] | undefined>("readonly", (store) =>
      store.get(handle),
    );
    if (!stored) return null;
    const byPath = new Map(stored.map((image) => [image.path, image.blob]));
    const images: PageImage[] = [];
    for (const path of paths) {
      const blob = byPath.get(path);
      if (!blob) return null;
      images.push({ path, blob });
    }
    return images;
  } catch {
    return null;
  }
}

/** Remove a setup's stored page images, if any. */
export function discardDraftImages(handle: string): void {
  inStore("readwrite", (store) => store.delete(handle)).catch(() => {});
}
