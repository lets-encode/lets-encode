<!--
  One line about a page's background updates while a rate limit pauses them
  or after several failed in a row; nothing otherwise. It goes away when the
  pause ends or with the next successful update. `retrying` says whether
  polls follow on their own; `bar` draws it full width.
-->
<script lang="ts">
  import { auth, login } from "$lib/auth.svelte.ts";
  import type { RefreshStatus } from "$lib/auto-refresh.ts";

  let {
    status,
    retrying = true,
    bar = true,
  }: { status: RefreshStatus; retrying?: boolean; bar?: boolean } = $props();

  // Failed updates in a row before the line shows: single failures pass.
  const SHOWN_AFTER = 3;

  // A pause's end is rounded up to the minute so it is never early; the start
  // of the failures is rounded down.
  const clock = (ms: number, up: boolean) =>
    new Date(
      (up ? Math.ceil : Math.floor)(ms / 60_000) * 60_000,
    ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
</script>

{#if status.pausedUntil !== null}
  <div class="banner warn" class:bar>
    <span>
      Updates paused until {clock(status.pausedUntil, true)}: {status.limit ===
      "broker"
        ? "too many requests were sent in a short time."
        : status.limit === "anonymous"
          ? "GitHub's limit for logged-out visitors is reached."
          : "GitHub's request limit is reached."}
      {#if status.limit === "anonymous" && !auth.user}
        <button type="button" class="linkish" onclick={() => login()}
          >Log in</button
        >
      {/if}
    </span>
  </div>
{:else if status.failingSince !== null && status.failures >= SHOWN_AFTER}
  <div class="banner warn" class:bar>
    <span>
      Updates have failed since {clock(status.failingSince, false)}.{retrying
        ? " Retrying."
        : ""}
    </span>
  </div>
{/if}
