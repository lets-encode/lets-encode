// Small helpers shared by the app and the automation scripts. Browser- and
// Node-safe; imports nothing.

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A random id of 8 hex digits. */
export const shortId = (): string => crypto.randomUUID().slice(0, 8);

/** The SHA-256 digest of `data` as lowercase hex. */
export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
