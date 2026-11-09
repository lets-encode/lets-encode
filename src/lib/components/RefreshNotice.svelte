<!--
  One line about a page's background updates while a rate limit pauses them
  or after several failed in a row; nothing otherwise. It goes away when the
  pause ends or with the next successful update. `retrying` says whether
  polls follow on their own; `bar` draws it as a full-width strip, else as
  a card.
-->
<script lang="ts">
  import { auth, login } from "$lib/auth.svelte.ts";
  import type { RefreshStatus } from "$lib/auto-refresh.ts";
  import { minuteClock } from "$lib/forge/github-rest.ts";
  import Notice from "./Notice.svelte";

  let {
    status,
    retrying = true,
    bar = true,
  }: { status: RefreshStatus; retrying?: boolean; bar?: boolean } = $props();

  // Failed updates in a row before the line shows: single failures pass.
  const SHOWN_AFTER = 3;
</script>

{#if status.pausedUntil !== null}
  <Notice
    tone="warn"
    surface={bar ? "strip" : "card"}
    icon="clock-pause"
    title={`Updates paused until ${minuteClock(status.pausedUntil, true)}`}
    detail={status.limit === "broker"
      ? "Too many requests were sent in a short time."
      : status.limit === "anonymous"
        ? "GitHub's limit for logged-out visitors is reached."
        : "GitHub's request limit is reached."}
    action={status.limit === "anonymous" && !auth.user
      ? { label: "Log in with GitHub", run: () => login() }
      : undefined}
  />
{:else if status.failingSince !== null && status.failures >= SHOWN_AFTER}
  <Notice
    tone="warn"
    surface={bar ? "strip" : "card"}
    title={`Updates have failed since ${minuteClock(status.failingSince, false)}`}
    detail={retrying ? "Retrying." : ""}
  />
{/if}
