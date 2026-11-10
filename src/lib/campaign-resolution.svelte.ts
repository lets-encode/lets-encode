// Resolves a task page's campaign name (the URL's /<campaign>) to its repo.
// Constructed during a component's initialisation: the effects run for the
// component's lifetime.

import { auth } from "./auth.svelte.ts";
import { readForge } from "./command-runner.svelte.ts";
import {
  resolveCampaign,
  campaignLoadFailure,
  type ResolvedCampaign,
} from "./campaign-resolve.ts";

export class CampaignResolution {
  resolved = $state<ResolvedCampaign | null>(null);
  notFound = $state(false);
  /** A failed lookup (e.g. rate limit), as distinct from a missing campaign. */
  error = $state<string | null>(null);
  // State, so a lookup that ends after a navigation re-runs the effect for
  // the new name.
  #resolving = $state(false);

  owner = $derived(this.resolved?.owner ?? "");
  repo = $derived(this.resolved?.repo ?? "");
  repoId = $derived(this.resolved?.repoId ?? 0);

  constructor(name: () => string) {
    $effect(() => {
      if (
        auth.status === "loading" ||
        this.resolved ||
        this.notFound ||
        this.error ||
        this.#resolving
      )
        return;
      this.#resolving = true;
      resolveCampaign(readForge(), name())
        .then((r) => {
          if (r) this.resolved = r;
          else this.notFound = true;
        })
        .catch((e) => {
          this.error = campaignLoadFailure(e);
        })
        .finally(() => (this.#resolving = false));
    });
  }

  /** Look the name up again after a failed lookup. */
  retry() {
    this.error = null;
  }
}
