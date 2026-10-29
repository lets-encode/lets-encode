<!--
  A campaign page's state while it cannot show its content: loading, a
  failed load with Try again, a campaign or task that does not exist, a
  repository without tracking tables, or a visitor who is not logged in.
  Pass exactly one of the states.
-->
<script lang="ts">
  import { auth, login } from "$lib/auth.svelte.ts";

  let {
    loading,
    error,
    onretry,
    missingCampaign,
    missingTask,
    noTables = false,
    loggedOut = false,
    campaign,
  }: {
    /** What is loading, as in "the campaign". */
    loading?: string;
    /** A failed load's message, shown with Try again (`onretry`). */
    error?: string | null;
    onretry?: () => void;
    /** The name of a campaign that does not exist. */
    missingCampaign?: string;
    /** The id of a task that does not exist in `campaign`. */
    missingTask?: string;
    /** The repository has no tracking tables. */
    noTables?: boolean;
    /** The page needs a login to work on its task. */
    loggedOut?: boolean;
    /** The campaign the page belongs to, for the link back to it. */
    campaign?: string;
  } = $props();
</script>

{#snippet back()}
  {#if campaign}
    <a href={`/${campaign}`}>Back to the campaign</a>.
  {:else}
    <a href="/campaigns">Back to all campaigns</a>.
  {/if}
{/snippet}

<div class="pagestate">
  {#if loading}
    <p class="loading">Loading {loading}…</p>
  {:else if error}
    <div class="banner err" role="alert">
      <span>
        {error}
        <button type="button" class="linkish" onclick={onretry}
          >Try again</button
        >
      </span>
    </div>
  {:else if missingCampaign}
    <div class="banner err" role="alert">
      <span>
        No campaign called <code>{missingCampaign}</code> was found. It may have
        been removed, or the name may be misspelled.
        <a href="/campaigns">Back to all campaigns</a>.
      </span>
    </div>
  {:else if missingTask}
    <div class="banner err" role="alert">
      <span>
        No task called <code>{missingTask}</code> was found in this campaign.
        {@render back()}
      </span>
    </div>
  {:else if noTables}
    <div class="banner err" role="alert">
      <span>
        This repository has no tracking tables yet. {@render back()}
      </span>
    </div>
  {:else if loggedOut}
    <div class="banner warn">
      <span>
        {#if auth.expired}Your GitHub login has expired.{/if}
        <button type="button" class="linkish" onclick={() => login()}
          >Log in with GitHub</button
        >
        to work on this task.
      </span>
    </div>
  {/if}
</div>

<style>
  .pagestate {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1.25rem 2rem;
    box-sizing: border-box;
  }
  .loading {
    margin: 0;
    color: var(--ink-faint);
  }
</style>
