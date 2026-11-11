<!--
  The campaign's details in the owner's side panel, above the campaign
  comments: the score's header fields and who worked on it, then the
  campaign's repository, description, visibility, licence and review
  threshold.
-->
<script lang="ts">
  import { readForge } from "$lib/command-runner.svelte.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import type { HistoryRow } from "$lib/campaign-tables.ts";
  import type { ScoreHead } from "$lib/campaign-page/score-head.svelte.ts";

  let {
    scoreHead,
    history,
    logins,
    owner,
    repo,
    description,
    isPrivate,
    license,
    passThreshold,
  }: {
    scoreHead: ScoreHead;
    history: HistoryRow[];
    logins: Record<string, string>;
    owner: string;
    repo: string;
    description: string;
    isPrivate: boolean;
    license: string;
    passThreshold: number;
  } = $props();

  // Everyone the campaign history records as having acted on the score.
  const workedOn = $derived(
    [...new Set(history.map((h) => h.user_id))].filter(Boolean),
  );
</script>

<div class="cinfo">
  <div class="isec">
    <span class="seclabel">Score</span>
    {#if scoreHead.state === "loading"}
      <span class="muted inote">Loading the score header…</span>
    {:else if scoreHead.state === "error"}
      <span class="muted inote">Could not read the score.</span>
    {:else if scoreHead.state === "done" && !scoreHead.head}
      <span class="muted inote">The score has no MEI header.</span>
    {:else if scoreHead.head}
      <div class="irow">
        <span>Title</span>
        <span>{scoreHead.head.title || "—"}</span>
      </div>
      <div class="irow">
        <span>Composer</span>
        <span>{scoreHead.head.composer || "—"}</span>
      </div>
    {/if}
    <div
      class="irow"
      title="Everyone the campaign history records: claims, submissions and reviews."
    >
      <span>Worked on this</span>
      <span>
        {#if workedOn.length}
          {#each workedOn as u, i (u)}{i > 0 ? ", " : ""}<a
              class="mono"
              href={readForge().userWebUrl(handle(logins, u))}
              target="_blank"
              rel="noreferrer">@{handle(logins, u)}</a
            >{/each}
        {:else}—{/if}
      </span>
    </div>
  </div>
  <div class="isec">
    <span class="seclabel">Campaign</span>
    <div class="irow">
      <span>Repository</span>
      <a
        class="mono"
        href={readForge().repoWebUrl(owner, repo)}
        target="_blank"
        rel="noreferrer">{owner}/{repo}</a
      >
    </div>
    <div class="irow">
      <span>About</span>
      <span>{description || "—"}</span>
    </div>
    <div class="irow">
      <span>Visibility</span>
      <span>{isPrivate ? "Private" : "Public"}</span>
    </div>
    <div
      class="irow"
      title="Contributions to this campaign are published under this licence."
    >
      <span>Licence</span>
      <span>{license || "—"}</span>
    </div>
    <div
      class="irow"
      title="Approving reviews each task needs before it counts as done."
    >
      <span>Reviews required</span>
      <span>{passThreshold}</span>
    </div>
  </div>
</div>

<style>
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .muted {
    color: var(--ink-faint);
  }
  /* The owner's side panel, above the campaign comments. */
  .cinfo {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 2px 2px 12px;
    border-bottom: 1px solid var(--line);
  }
  .isec {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .inote {
    font-size: 11px;
  }
  /* A fixed label column with the value directly after it, left-aligned. */
  .irow {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 10px;
    font-size: 12px;
  }
  /* On the recessed panel, labels take the soft ink (faint ink is for the
     canvas and cards). */
  .irow > span:first-child {
    color: var(--ink-soft);
  }
  .irow > :last-child {
    overflow-wrap: anywhere;
  }
  .irow a {
    color: var(--link);
    text-decoration: none;
  }
  @media (hover: hover) {
    .irow a:hover {
      text-decoration: underline;
    }
  }
  .seclabel {
    font-weight: 600;
    font-size: 12px;
    color: var(--ink-soft);
  }
</style>
