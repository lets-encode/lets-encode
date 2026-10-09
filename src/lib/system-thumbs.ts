// Small images of a page's first system for the campaign list, cut in the
// browser from the full page scan and kept per browser in IndexedDB, so that
// a later visit to the list loads none of the scans. Nothing is written to the
// campaign repo. A record is keyed by the scan's address without its query
// (private repos' download URLs carry a token that changes) and by the system
// box, so a measure correction that moves the system makes a new record.
// Every call resolves; without IndexedDB or canvas the image is cut on every
// visit, and a scan the browser cannot read resolves to null.

import type { MeasureBox } from "./mei-facsimile.ts";
import type { PagePreview } from "./piece-previews.ts";

const DB = "lets-encode-system-thumbs";
const STORE = "systems";
/** Width of the kept image: twice the widest strip, for dense screens. */
const WIDTH = 600;
/** The cut is this many times as wide as it is tall, wider than any strip. */
const ASPECT = 3;
/** Margin above and below the system, as a share of its height. */
const PAD = 0.12;
/** Milliseconds to wait for the store to open. */
const OPEN_TIMEOUT = 2000;

/** The part of the page to cut, in the page's coordinate space. */
export function systemRegion(
  page: { width: number; height: number },
  system: MeasureBox,
): MeasureBox | null {
  const pad = (system.lry - system.uly) * PAD;
  const uly = Math.max(0, system.uly - pad);
  const lry = Math.min(page.height, system.lry + pad);
  const lrx = Math.min(page.width, system.ulx + (lry - uly) * ASPECT);
  if (lry <= uly || lrx <= system.ulx) return null;
  return { ulx: system.ulx, uly, lrx, lry };
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    // An open that another tab's pending deletion holds fires no event; the
    // images are then cut without the store.
    setTimeout(() => resolve(null), OPEN_TIMEOUT);
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function read(key: string): Promise<Blob | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(key);
      request.onsuccess = () =>
        resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function write(key: string, blob: Blob): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(blob, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function cut(
  page: PagePreview,
  region: MeasureBox,
): Promise<Blob | null> {
  const img = new Image();
  // The scan host allows any origin, so the canvas stays readable.
  img.crossOrigin = "anonymous";
  // The load event, not img.decode(): a hidden tab may defer decode() until
  // it is shown.
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = page.url;
  });
  if (!loaded || !img.naturalWidth) return null;
  const sx = img.naturalWidth / page.width;
  const sy = img.naturalHeight / page.height;
  const w = (region.lrx - region.ulx) * sx;
  const h = (region.lry - region.uly) * sy;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = Math.max(1, Math.round((WIDTH * h) / w));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    img,
    region.ulx * sx,
    region.uly * sy,
    w,
    h,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.8);
    } catch {
      resolve(null);
    }
  });
}

// One cut per scan and box per page load, shared by rows showing the same.
const pending = new Map<string, Promise<Blob | null>>();

/**
 * The first-system image of `page` as a Blob, from the browser's store or cut
 * from the scan; null when the page has no system or the scan is unreadable.
 */
export function systemThumb(page: PagePreview): Promise<Blob | null> {
  const region = page.url && page.system && systemRegion(page, page.system);
  if (!region) return Promise.resolve(null);
  const key = [
    page.url.split("?")[0],
    region.ulx,
    region.uly,
    region.lrx,
    region.lry,
  ].join("|");
  let loading = pending.get(key);
  if (!loading) {
    loading = read(key).then(async (kept) => {
      if (kept) return kept;
      const blob = await cut(page, region);
      if (blob) await write(key, blob);
      // A failed cut is not remembered, so a retry cuts again.
      else pending.delete(key);
      return blob;
    });
    pending.set(key, loading);
  }
  return loading;
}
