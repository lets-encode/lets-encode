/**
 * The wizard frame's view of the setups stored in the browser: how long ago
 * this one was saved, and the account's other setups, which can be resumed
 * from the frame. Both are created while a component initialises; the clock's
 * effect belongs to that component.
 */
import { auth } from "$lib/auth.svelte.ts";
import { timeAgo } from "$lib/campaign-board.ts";
import { resumableDrafts } from "$lib/wizard-draft.ts";
import {
  draftSnapshot,
  draftStatus,
  resumeDraft,
  saveDraft,
  wizard,
} from "$lib/wizard.svelte.ts";

/**
 * "Draft saved · just now": a clock that only needs to be roughly right, so
 * it ticks well below the minute it reports in.
 */
export class SavedClock {
  #now = $state(Date.now());

  constructor() {
    $effect(() => {
      if (draftStatus.savedAt === null) return;
      const clock = setInterval(() => (this.#now = Date.now()), 15_000);
      return () => clearInterval(clock);
    });
  }

  /** How long ago this setup was saved, or null before its first save. */
  readonly ago = $derived.by(() => {
    if (draftStatus.savedAt === null) return null;
    return timeAgo(new Date(draftStatus.savedAt).toISOString(), this.#now);
  });
}

/**
 * Other setups of this account stored in the browser, listed so one of them
 * can be picked up from here. Read again after each save of this one, since a
 * save is when the stored set changes.
 */
export class OtherDrafts {
  readonly list = $derived.by(() => {
    draftStatus.savedAt;
    const owner = auth.user?.login;
    if (!owner) return [];
    const handle = wizard.handle.trim();
    return resumableDrafts(owner).filter((d) => d.handle !== handle);
  });
  /** The handle of the setup being resumed. */
  resuming = $state<string | null>(null);
  error = $state<string | null>(null);

  async resume(handle: string) {
    if (this.resuming) return;
    this.error = null;
    this.resuming = handle;
    // The setup being left is saved on a debounce; write it now so its last
    // edits are kept.
    const owner = auth.user?.login;
    if (owner) saveDraft(owner, draftSnapshot());
    try {
      await resumeDraft(owner ?? "", handle);
    } catch (err) {
      this.error = `Could not resume “${handle}”: ${(err as Error).message}`;
    }
    this.resuming = null;
  }
}
