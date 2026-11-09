// The browser's localStorage, read and written so that nothing throws: where
// there is no storage (outside a browser), or the browser blocks site data
// (any access then throws), a read finds nothing and a write reports the
// browser's message.

const storage = (): Storage | null =>
  typeof localStorage === "undefined" ? null : localStorage;

/** The value stored under `key`; null when there is none or it cannot be read. */
export function readLocal(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** The JSON value stored under `key`; null when there is none or it is not JSON. */
export function readLocalJson(key: string): unknown {
  const raw = readLocal(key);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Store `value` under `key`. Returns the browser's message when it refused
    the write, null when stored or when there is no storage. */
export function writeLocal(key: string, value: string): string | null {
  try {
    storage()?.setItem(key, value);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Remove what is stored under `key`, if the browser lets it be removed. */
export function removeLocal(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* blocked storage holds nothing to remove */
  }
}

/** The keys stored, those starting with `prefix`; none when they cannot be read. */
export function localKeys(prefix: string): string[] {
  try {
    const s = storage();
    if (!s) return [];
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
