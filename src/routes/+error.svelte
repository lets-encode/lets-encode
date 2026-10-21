<!--
  The page shown when a route fails to load or does not exist: what happened,
  in the layout's frame, with a way back to the campaign list.
-->
<script lang="ts">
  import { page } from "$app/state";

  const missing = $derived(page.status === 404);
</script>

<svelte:head>
  <title>{missing ? "Page not found" : "Error"} · Let's Encode!</title>
</svelte:head>

<section class="error">
  <h1>{missing ? "Page not found" : "This page could not be loaded"}</h1>
  <p>
    {#if missing}
      There is no page at this address.
    {:else}
      {page.error?.message ?? "The page failed to load."} Reload the page to try again.
    {/if}
  </p>
  <p class="actions">
    <a class="btn btn-primary" href="/campaigns">All campaigns</a>
    {#if !missing}
      <button
        type="button"
        class="btn btn-secondary"
        onclick={() => location.reload()}>Reload</button
      >
    {/if}
  </p>
  <p class="status">Status {page.status}</p>
</section>

<style>
  .error {
    max-width: 520px;
    margin: 3rem auto 0;
  }
  h1 {
    margin: 0;
    font-size: 21px;
    font-weight: 600;
    line-height: 1.25;
  }
  p {
    margin: 10px 0 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-soft);
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
  }
  .status {
    margin-top: 22px;
    font-size: 11.5px;
    color: var(--ink-faint);
  }
</style>
