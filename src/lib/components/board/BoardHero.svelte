<!--
  The owner's board header: the campaign's title, its repository link, the
  Manage and View score buttons, and one line of counts with the board
  filter; the attention count unfolds the tasks behind it.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import ProgressBar from "$lib/components/ProgressBar.svelte";
  import ScopeToggle from "$lib/components/board/ScopeToggle.svelte";
  import type { Board, BoardCard } from "$lib/campaign-board.ts";
  import type { BoardScope } from "$lib/campaign-page/board-columns.ts";

  let {
    name,
    repoLabel,
    repoUrl,
    canManage,
    busy,
    canViewScore,
    scoreHint,
    viewScoreButton = $bindable(),
    board,
    attentionCards,
    showAttention = $bindable(),
    scope = $bindable(),
    onmanage,
    onviewscore,
    onopen,
  }: {
    /** The campaign's title, else its repository name. */
    name: string;
    /** owner/repo, the repository link's text. */
    repoLabel: string;
    repoUrl: string;
    /** The Manage button shows. */
    canManage: boolean;
    busy: boolean;
    canViewScore: boolean;
    scoreHint: string;
    viewScoreButton?: HTMLButtonElement;
    board: Board;
    attentionCards: BoardCard[];
    showAttention: boolean;
    scope: BoardScope;
    onmanage: () => void;
    onviewscore: () => void;
    onopen: (task: string) => void;
  } = $props();
</script>

<div class="hero">
  <div class="hero-line">
    <h1 title={name}>{name}</h1>
    <a class="mono slug" href={repoUrl} target="_blank" rel="noreferrer"
      >{repoLabel} <Icon name="external" size={12} /></a
    >
    <div class="hero-acts">
      {#if canManage}
        <button
          type="button"
          class="btn managechip"
          onclick={() => onmanage()}
          disabled={busy}
          aria-label="Manage"
          title="Owner only: plan editor and expired-claim release"
          ><Icon name="gear" /><span class="managelabel">Manage</span></button
        >
      {/if}
      {#if canViewScore}
        <button
          type="button"
          class="btn scorebtn on-tint"
          bind:this={viewScoreButton}
          onclick={onviewscore}
          title={scoreHint}>View score</button
        >
      {/if}
    </div>
  </div>
  <!-- One line: the progress first; the other counts give way
       as the column narrows, the attention count last. -->
  <div class="hero-stats" class:quiet={board.attention === 0}>
    <span class="heroprogress">
      <ProgressBar done={board.done} total={board.total} />
    </span>
    <span class="sep m2">·</span>
    <span class="stat m2"
      ><b class="c-info">{board.inFlight}</b> in progress</span
    >
    {#if board.attention > 0}
      <span class="sep m2">·</span>
      <button
        type="button"
        class="stat statbtn"
        onclick={() => (showAttention = !showAttention)}
        title="Show the tasks with unresolved change requests or comments."
        ><b>{board.attention}</b> need{board.attention === 1 ? "s" : ""} attention
        <Icon
          name={showAttention ? "chevron-down" : "chevron-right"}
          size={12}
        /></button
      >
    {:else}
      <span class="sep m2">·</span>
      <span class="stat m2"><b>0</b> need attention</span>
    {/if}
    <span class="sep m1">·</span>
    <span class="stat m1"
      ><b>{board.contributorsWeek}</b>
      contributor{board.contributorsWeek === 1 ? "" : "s"} this week</span
    >
    <ScopeToggle bind:scope />
  </div>
  {#if showAttention && attentionCards.length > 0}
    <div class="attnbox">
      {#each attentionCards as card (card.task)}
        <button
          type="button"
          class="attnrow"
          onclick={() => onopen(card.task)}
          title="Open this task"
        >
          <span class="attntitle">{card.title}</span>
          <span class="attnspacer"></span>
          {#if card.counts.fails > 0 && card.column !== "done"}
            <span class="chip chip-fail"
              >{card.counts.fails} change request{card.counts.fails === 1
                ? ""
                : "s"}</span
            >
          {/if}
          {#if card.counts.comments > 0}
            <span class="chip chip-note"
              >{card.counts.comments} comment{card.counts.comments === 1
                ? ""
                : "s"}</span
            >
          {/if}
          <span class="attnchev"><Icon name="chevron-right" /></span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .hero {
    flex: none;
    padding: 18px 32px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  /* The title, its repository link and the actions share one line. A title
     longer than the room left is cut short; the full title is its tooltip. */
  .hero-line {
    display: flex;
    align-items: center;
    gap: 10px 14px;
    min-width: 0;
  }
  .hero-line h1 {
    margin: 0;
    min-width: 0;
    font-size: 26px;
    line-height: 1.2;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Below desktop width the repository link gives way; it is in the campaign
     details in the side panel. */
  @container (max-width: 1100px) {
    .slug {
      display: none;
    }
  }
  .hero-acts {
    flex: none;
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .slug {
    font-size: 13px;
    color: var(--ink-faint);
    text-decoration: none;
    flex: none;
    /* A 24px pointer target without moving the text. */
    padding: 5px 0;
    margin: -5px 0;
  }
  @media (hover: hover) {
    .slug:hover {
      text-decoration: underline;
    }
  }
  .hero-acts .btn,
  .hero-line .btn {
    padding-block: 4px;
  }
  .managechip {
    color: var(--owner);
    background: var(--owner-bg);
    border-color: var(--owner-line);
  }
  @media (hover: hover) {
    .managechip:hover:not(:disabled) {
      color: var(--owner);
      border-color: var(--owner);
    }
  }
  .managechip {
    gap: 6px;
  }
  .hero-stats {
    display: flex;
    gap: 10px;
    align-items: center;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 5px 6px 5px 16px;
    box-shadow: var(--shadow-sm);
  }
  /* The board filter is ScopeToggle's root. */
  .hero-stats > *,
  .hero-stats > :global(.seg) {
    white-space: nowrap;
  }
  .hero-stats :global(.seg) {
    margin-left: auto;
  }
  @container (max-width: 1100px) {
    .hero-stats .m1 {
      display: none;
    }
  }
  .heroprogress {
    flex: 0 1 auto;
    min-width: 0;
    --track-w: 420px;
  }
  .stat {
    font-size: 13px;
    color: var(--ink-soft);
  }
  .stat b {
    font-weight: 600;
  }
  .stat b.c-info {
    color: var(--info);
  }
  .sep {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .statbtn {
    font: inherit;
    font-size: 13px;
    color: var(--danger);
    background: none;
    border: 0;
    padding: 5px 0;
    margin: -5px 0;
    cursor: pointer;
    text-decoration: underline;
  }
  /* The tasks behind the attention count, unfolded from the stat. */
  .attnbox {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
    border-radius: 12px;
    padding: 10px 14px;
  }
  .attnrow {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 14px;
    cursor: pointer;
  }
  @media (hover: hover) {
    .attnrow:hover {
      border-color: var(--accent);
    }
  }
  .attntitle {
    font-weight: 600;
  }
  .attnspacer {
    flex: 1;
  }
  .attnchev {
    font-size: 15px;
    color: var(--ink-faint);
  }
  @container view (max-width: 700px) {
    .hero-stats > :global(.seg),
    .hero-stats.quiet {
      display: none;
    }
  }
  /* A narrow view column (a phone): the title is smaller, the side margins
     shrink, and Manage is its gear only. */
  @container (max-width: 700px) {
    .hero {
      padding: 10px 16px 8px;
      gap: 8px;
    }
    .hero-line {
      gap: 8px 10px;
    }
    .hero-line h1 {
      font-size: 20px;
    }
    .managechip {
      width: 32px;
      padding: 0;
      justify-content: center;
    }
    .managelabel {
      display: none;
    }
    /* The stats reduce to the attention count when there is one and the
       filter, on one plain line without the card. */
    .hero-stats {
      flex-wrap: wrap;
      gap: 6px 10px;
      padding: 0;
      background: none;
      border: 0;
      box-shadow: none;
    }
    .hero-stats .m2,
    .heroprogress {
      display: none;
    }
  }
</style>
