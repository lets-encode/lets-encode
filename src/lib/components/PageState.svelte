<!--
  A campaign page's state while it cannot show its content: loading, a
  failed load with Try again, a campaign or task that does not exist, a
  repository without tracking tables, or a visitor who is not logged in.
  Pass exactly one of the states.
-->
<script lang="ts">
  import { auth, login } from "$lib/auth.svelte.ts";
  import Notice, { splitMessage } from "./Notice.svelte";

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

  const allCampaigns = {
    label: "All campaigns",
    href: "/campaigns",
    icon: "arrow-left" as const,
  };
  const back = $derived(
    campaign
      ? { label: "Campaign", href: `/${campaign}`, icon: "arrow-left" as const }
      : allCampaigns,
  );
</script>

<div class="pagestate">
  {#if loading}
    <p class="loading">Loading {loading}…</p>
  {:else if error}
    <Notice
      tone="err"
      {...splitMessage(error)}
      action={{ label: "Try again", run: onretry }}
    />
  {:else if missingCampaign}
    <Notice
      tone="err"
      title={`No campaign called ${missingCampaign}`}
      detail="It may have been removed, or the name may be misspelled."
      action={allCampaigns}
    />
  {:else if missingTask}
    <Notice
      tone="err"
      title={`No task called ${missingTask} in this campaign`}
      action={back}
    />
  {:else if noTables}
    <Notice
      tone="err"
      title="This repository has no tracking tables yet"
      action={back}
    />
  {:else if loggedOut}
    <Notice
      tone="warn"
      icon="lock"
      title={auth.expired
        ? "Your GitHub login has expired"
        : "Log in to work on this task"}
      detail={auth.expired ? "Log in to work on this task." : ""}
      action={{ label: "Log in with GitHub", run: () => login() }}
    />
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
