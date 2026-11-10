// Opening a browser IndexedDB database of one object store, shared by the
// stores the app keeps per browser. The open never waits without end: another
// tab's pending deletion of the database holds an open without firing any
// event, so after OPEN_TIMEOUT the store counts as unavailable.

/** Milliseconds to wait for a database to open. */
const OPEN_TIMEOUT = 2000;

/**
 * A function that opens database `db` with its one object store `store`,
 * once, and hands out the same connection afterwards until the browser closes
 * it or another tab asks for a newer version; null when the browser has no
 * IndexedDB, or the open fails, is blocked or takes longer than OPEN_TIMEOUT.
 * A failed or closed connection is opened again on the next call.
 */
export function storeOpener(
  db: string,
  store: string,
): () => Promise<IDBDatabase | null> {
  let opening: Promise<IDBDatabase | null> | null = null;
  return () => {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    if (opening) return opening;
    const attempt = new Promise<IDBDatabase | null>((resolve) => {
      setTimeout(() => resolve(null), OPEN_TIMEOUT);
      try {
        const request = indexedDB.open(db, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onsuccess = () => {
          const connection = request.result;
          const drop = () => {
            if (opening === attempt) opening = null;
          };
          connection.onclose = drop;
          connection.onversionchange = () => {
            connection.close();
            drop();
          };
          resolve(connection);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    opening = attempt;
    void attempt.then((connection) => {
      if (!connection && opening === attempt) opening = null;
    });
    return attempt;
  };
}
