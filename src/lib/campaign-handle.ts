// Campaign handle validation. Pure string logic — no forge or DOM access.

// The handle is also the GitHub repo name AND the campaign's registry slug, so
// it must satisfy the registry's slug rules (lowercase, digits, single internal
// hyphens, length 3–40). broker/test_registry.py checks the pattern against
// broker/slug_validation.py.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

export const isValidHandle = (h: string) =>
  h.length >= 3 && SLUG_RE.test(h) && !h.includes("--");
