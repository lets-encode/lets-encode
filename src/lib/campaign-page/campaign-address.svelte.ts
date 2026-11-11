// The campaign page's address: the URL carries only the campaign name; the
// repo it addresses is resolved from it (name → stable repo id → current
// owner/name) — see resolveCampaign. The name's registry state decides what
// the page is: a live campaign renders, a free name forwards to the wizard
// with the name prefilled, and a name that is held, reserved or blocked
// explains itself.
//
// Constructed during a component's initialisation: the effect runs for the
// component's lifetime.

import { goto } from "$app/navigation";
import { auth } from "../auth.svelte.ts";
import { readForge } from "../command-runner.svelte.ts";
import {
  lookupSlug,
  resolveCampaign,
  campaignLoadFailure,
} from "../campaign-resolve.ts";
import type { ResolvedCampaign, SlugInfo } from "../campaign-resolve.ts";

export class CampaignAddress {
  resolved = $state<ResolvedCampaign | null>(null);
  resolving = $state(false);
  notFound = $state(false);
  // The forge lookup of the registry's repo id failed (e.g. rate limit) — the
  // campaign exists but could not be loaded, which is not a "not found".
  resolveError = $state<string | null>(null);
  // A name that is not (yet) a campaign: held by a setup in progress, reserved
  // for the app's own routes, or blocked. A free name never renders here — it
  // forwards to the wizard.
  slugState = $state<"pending" | "reserved" | "tombstoned" | null>(null);
  owner = $derived(this.resolved?.owner ?? "");
  repo = $derived(this.resolved?.repo ?? "");
  repoId = $derived(this.resolved?.repoId ?? 0);

  #campaign: () => string;

  constructor(campaign: () => string) {
    this.#campaign = campaign;
    // Resolve the campaign name to its repo before anything reads the
    // tables. The table load is gated on `owner`/`repo`, so it waits for this.
    $effect(() => {
      if (
        auth.status === "loading" ||
        this.resolved ||
        this.notFound ||
        this.resolveError ||
        this.slugState ||
        this.resolving
      )
        return;
      this.resolving = true;
      this.resolve().finally(() => (this.resolving = false));
    });
  }

  async resolve() {
    const name = this.#campaign();
    let info: SlugInfo | null;
    try {
      info = await lookupSlug(name);
    } catch (e) {
      this.resolveError = campaignLoadFailure(e);
      return;
    }
    // A free name opens the setup for it, unless the page was left meanwhile.
    if (name !== this.#campaign()) return;
    if (info?.status === "free") {
      await goto(`/new?slug=${encodeURIComponent(name)}`, {
        replaceState: true,
      });
      return;
    }
    if (
      info?.status === "pending" ||
      info?.status === "reserved" ||
      info?.status === "tombstoned"
    ) {
      this.slugState = info.status;
      return;
    }
    // Active — or the name malformed, which resolveCampaign reports as null
    // (notFound). A thrown forge error (e.g. rate limit) is a failed lookup,
    // not a missing campaign. The lookup above
    // is passed through so the name is not fetched from the registry twice.
    let r: ResolvedCampaign | null = null;
    try {
      r = await resolveCampaign(readForge(), name, info);
    } catch (e) {
      this.resolveError = campaignLoadFailure(e);
      return;
    }
    if (r) this.resolved = r;
    else this.notFound = true;
  }
}
