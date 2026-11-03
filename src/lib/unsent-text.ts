// Text typed into a form but not yet sent, kept in this tab's session storage
// across a reload the app makes itself (the login changed in another tab), so
// the form opens again with it — for the account it was typed under only.

const PREFIX = "lets-encode:unsent:";
const sources = new Map<string, () => unknown>();

/**
 * Register a form's unsent content under `key`; `read` returns null when there
 * is nothing to keep. Returns the function that unregisters it.
 */
export function keepUnsent(key: string, read: () => unknown): () => void {
  sources.set(key, read);
  return () => {
    if (sources.get(key) === read) sources.delete(key);
  };
}

/**
 * Store every registered form's unsent content with the `account` it was
 * typed under, then reload the page.
 */
export function reloadKeepingUnsent(account: string | null): void {
  for (const [key, read] of sources) {
    const value = read();
    if (value == null || !account) continue;
    try {
      sessionStorage.setItem(PREFIX + key, JSON.stringify({ account, value }));
    } catch {
      // Storage refused: the text is not kept.
    }
  }
  location.reload();
}

/**
 * The content stored under `key` before a reload, when it was typed under
 * `account`; removed as it is read. Content of another account stays stored.
 */
export function takeUnsent<T>(key: string, account: string | null): T | null {
  if (!account) return null;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as { account: string; value: T };
    if (stored.account !== account) return null;
    sessionStorage.removeItem(PREFIX + key);
    return stored.value;
  } catch {
    return null;
  }
}
