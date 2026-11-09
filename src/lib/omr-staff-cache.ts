// Staff transcriptions kept per browser while a score setup's recognition
// runs, so that leaving the editor or a failed run does not require the
// staves already transcribed to run again. One record per campaign repo,
// staff box key and box, for one staff pipeline version and crop margin, in
// IndexedDB (a piece's MusicXML outgrows localStorage). Failed staves are not
// kept. Every call resolves, and without IndexedDB nothing is kept.

import { storeOpener } from "./idb-store.ts";
import type { MeasureBox } from "./mei-facsimile.ts";
import type { OmrPipeline } from "./omr-client.ts";

/** What is kept for a staff: its MusicXML and the label read in front of it. */
export interface CachedStaff {
  musicxml: string;
  label: string;
}

const DB = "lets-encode-omr";
const STORE = "staves";

export const staffCacheKey = (
  repoId: number,
  zone: string,
  box: MeasureBox,
  pipeline: OmrPipeline,
  cropMargin: number,
): string =>
  // Corners rounded to whole pixels, as the record compares them (sameBox).
  [
    repoId,
    zone,
    Math.round(box.ulx),
    Math.round(box.uly),
    Math.round(box.lrx),
    Math.round(box.lry),
    pipeline.name,
    pipeline.version,
    cropMargin,
  ].join("|");

const open = storeOpener(DB, STORE);

/** The kept staves for `keys`, by key; a key with nothing kept is absent. */
export async function readCachedStaves(
  keys: string[],
): Promise<Map<string, CachedStaff>> {
  const db = await open();
  const found = new Map<string, CachedStaff>();
  if (!db || !keys.length) return found;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      let left = keys.length;
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result) found.set(key, request.result as CachedStaff);
          if (--left === 0) resolve(found);
        };
        request.onerror = () => {
          if (--left === 0) resolve(found);
        };
      }
    } catch {
      resolve(found);
    }
  });
}

/** Keep staves by key. */
export async function writeCachedStaves(
  entries: [string, CachedStaff][],
): Promise<void> {
  const db = await open();
  if (!db || !entries.length) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      for (const [key, value] of entries) store.put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
