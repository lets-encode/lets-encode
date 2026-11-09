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

// A setup's images are stored under its account and name.
const imagesKey = (owner: string, handle: string) => `${owner}/${handle}`;

/**
 * Store a setup's page images, replacing any stored before. Returns the
 * browser's message when it refused the write, null when stored.
 */
export async function storeDraftImages(
  owner: string,
  handle: string,
  images: PageImage[],
): Promise<string | null> {
  try {
    await inStore("readwrite", (store) =>
      store.put(
        images.map(({ path, blob }) => ({ path, blob })),
        imagesKey(owner, handle),
      ),
    );
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * The page images stored for a setup, in the order of `paths`, when every one
 * of them is there and has the byte size `sizes` records for it; null when any
 * is missing or of another size (stored for another choice of pages under the
 * same paths), or the browser's image store cannot be opened (the images
 * were never stored then). Throws when the store opens but cannot be read: the
 * images may still be in it.
 */
export async function readDraftImages(
  owner: string,
  handle: string,
  paths: string[],
  sizes?: number[],
): Promise<PageImage[] | null> {
  try {
    (await openDb()).close();
  } catch {
    return null;
  }
  try {
    const stored = await inStore<unknown>("readonly", (store) =>
      store.get(imagesKey(owner, handle)),
    );
    if (!Array.isArray(stored)) return null;
    const byPath = new Map(stored.map((image) => [image.path, image.blob]));
    const images: PageImage[] = [];
    for (const [i, path] of paths.entries()) {
      const blob = byPath.get(path);
      if (!blob || (sizes && blob.size !== sizes[i])) return null;
      images.push({ path, blob });
    }
    return images;
  } catch (err) {
    throw new Error(
      `the page images could not be read from this browser's storage (${(err as Error).message})`,
    );
  }
}

/**
 * Move the page images stored under a setup's name alone (before drafts were
 * kept per account) to `owner`'s key. Best-effort, in the background.
 */
export function moveUnkeyedDraftImages(owner: string, handle: string): void {
  void (async () => {
    try {
      const stored = await inStore<unknown>("readonly", (store) =>
        store.get(handle),
      );
      if (stored === undefined) return;
      await inStore("readwrite", (store) =>
        store.put(stored, imagesKey(owner, handle)),
      );
      await inStore("readwrite", (store) => store.delete(handle));
    } catch {
      // A failed move leaves the images where they were.
    }
  })();
}

/** Remove a setup's stored page images, if any. */
export function discardDraftImages(owner: string, handle: string): void {
  inStore("readwrite", (store) => store.delete(imagesKey(owner, handle))).catch(
    () => {},
  );
}
