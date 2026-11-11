<!--
  The owner's board lanes: four lanes of task cards (Open, Encoding, Review,
  Done) in the stage colours; stacked in one column when four do not fit,
  and one lane at a time behind lane tabs on a phone-width column. Under
  the Claimable filter an empty board says why.
-->
<script lang="ts">
  import BoardCard from "$lib/components/board/BoardCard.svelte";
  import type { BoardColumn, ColumnKey } from "$lib/campaign-board.ts";
  import type { BoardScope } from "$lib/campaign-page/board-columns.ts";

  let {
    columns,
    laneTab,
    boardScope,
    repoId,
    viewer,
    logins,
    detailTask,
    completedTask,
    recentlyFinished,
    piecesListed,
    zoneOf,
    reviewExpiry,
    onpicklane,
    onopen,
  }: {
    /** The lanes under the piece and Claimable filters. */
    columns: BoardColumn[];
    /** The lane the lane tabs show. */
    laneTab: ColumnKey;
    boardScope: BoardScope;
    repoId: number;
    viewer: string;
    logins: Record<string, string>;
    /** The task the side panel shows, else null. */
    detailTask: string | null;
    /** The task mei-friend just reported complete, else null. */
    completedTask: string | null;
    /** Tasks the viewer's submissions just moved. */
    recentlyFinished: Set<string>;
    /** Cards name their piece. */
    piecesListed: boolean;
    zoneOf: (task: string) => number;
    reviewExpiry: (task: string, sub: string, user: string) => string;
    onpicklane: (lane: ColumnKey) => void;
    onopen: (task: string) => void;
  } = $props();
</script>

<!-- A toggle group: the pressed lane is the one shown. -->
<div class="lanetabs" role="group" aria-label="Lanes">
  {#each columns as col (col.key)}
    <button
      type="button"
      class="lanetab c-{col.key}"
      class:on={laneTab === col.key}
      aria-pressed={laneTab === col.key}
      onclick={() => onpicklane(col.key)}
      >{col.label}
      <span class="lanetab-count">{col.cards.length}</span></button
    >
  {/each}
</div>
{#if boardScope === "open" && columns.every((c) => c.cards.length === 0)}
  <p class="boardnote">
    No tasks are open right now: every task is claimed, in review, waiting for
    an earlier task, or done.
  </p>
{/if}
<div class="board">
  {#each columns as col (col.key)}
    <div
      class="bcol c-{col.key}"
      class:tabsel={laneTab === col.key}
      class:empty={col.cards.length === 0}
    >
      <div class="bcol-head">
        <h2 class="bcol-name">{col.label}</h2>
        <span class="countpill">{col.cards.length}</span>
      </div>
      <div class="well">
        {#if col.cards.length === 0}
          <p class="laneempty">No tasks</p>
        {/if}
        {#each col.cards as card (card.task)}
          <BoardCard
            {card}
            {repoId}
            {viewer}
            {logins}
            selected={detailTask === card.task}
            {completedTask}
            recentlyFinished={recentlyFinished.has(card.task)}
            pieceListed={piecesListed}
            zone={zoneOf(card.task)}
            {reviewExpiry}
            {onopen}
          />
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  /* The split view (a narrow portrait or a short window, the page's
     .boardview.split): the board grows with its cards and the page region
     scrolls. */
  :global(.split) .board {
    flex: none;
    min-height: 0;
  }
  :global(.split) .board {
    overflow-y: visible;
  }
  :global(.split) .bcol {
    min-height: auto;
  }
  :global(.split) .well {
    overflow-y: visible;
    contain: none;
  }
  .boardnote {
    margin: 0;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .board {
    flex: 1;
    /* Roughly a column head and one card row — the least the board is ever
       shown with, so the dock panels stop growing before crushing it. */
    min-height: 170px;
    display: flex;
    gap: 12px;
  }
  /* Lanes keep a readable width; the board never scrolls sideways, the
     stack below takes over as soon as four lanes no longer fit. */
  .board > .bcol {
    min-width: 200px;
  }
  /* A lane is the stage's colour: a solid header bar with white lettering
     over a body in the stage's wash. The three lane tokens are set per
     column key below. */
  /* Lane lettering: the theme's inverted ink on the neutral lane, white on the
     stage colours' deep tones in both themes (as on solid buttons). */
  .bcol {
    --lane-solid: var(--ink-soft);
    --lane-ink: var(--invert-ink);
    --lane-text: var(--ink-soft);
    --lane-bg: var(--bg-tint);
    --lane-line: var(--line);
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--lane-bg);
    border: 1px solid var(--lane-line);
    border-radius: 12px;
    overflow: hidden;
  }
  .bcol-head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 12px;
    background: var(--lane-solid);
    color: var(--lane-ink);
  }
  /* An empty lane: its header in the stage's text colour on the lane's wash,
     and a line saying so. */
  .bcol.empty .bcol-head {
    background: none;
    color: var(--lane-text);
    border-bottom: 1px solid var(--lane-line);
  }
  .laneempty {
    margin: 0;
    font-size: 12px;
    color: var(--ink-soft);
  }
  /* The neutral Open lane in dark: a mid slate bar, not the light ink. */
  :global([data-theme="dark"]) .bcol:not(.c-encoding, .c-validation, .c-done),
  :global([data-theme="dark"])
    .lanetab:not(.c-encoding, .c-validation, .c-done) {
    --lane-solid: var(--line-strong);
    --lane-ink: var(--ink);
  }
  .bcol-name {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .bcol.c-blocked {
    --lane-solid: var(--ink-faint);
    --lane-bg: var(--bg-inset);
  }
  .bcol.c-encoding,
  .lanetab.c-encoding {
    --lane-solid: var(--info-solid);
    --lane-ink: #fff;
    --lane-text: var(--info);
    --lane-bg: var(--info-bg);
    --lane-line: var(--info-line);
  }
  .bcol.c-validation,
  .lanetab.c-validation {
    --lane-solid: var(--warn-solid);
    --lane-ink: #fff;
    --lane-text: var(--warn);
    --lane-bg: var(--warn-bg);
    --lane-line: var(--warn-line);
  }
  .bcol.c-done,
  .lanetab.c-done {
    --lane-solid: var(--ok-solid);
    --lane-ink: #fff;
    --lane-text: var(--ok);
    --lane-bg: var(--ok-bg);
    --lane-line: var(--ok-line);
  }
  .well {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* Sized by its column, never by its cards: a long card list scrolls in
       here instead of growing the board — and the board's own minimum stays
       one card row, however many tasks there are. */
    contain: size;
  }
  /* On a touch screen the cards are larger targets (BoardCard.svelte). */
  @media (pointer: coarse) {
    .well {
      gap: 10px;
    }
  }
  /* Measured on the board column, which the rail and the side panel narrow
     independently of the window. Four lanes need four 200px lanes with their
     borders and three 12px gaps (LANES_WIDTH); below that the lanes stack in
     one column, each as tall as its cards, and the board scrolls as a whole;
     below 420px one lane shows at a time, chosen by the lane tabs, and the
     tab replaces its head. */
  .lanetabs {
    display: none;
  }
  @container (max-width: 843px) {
    .board {
      flex-direction: column;
      min-height: 240px;
      overflow-y: auto;
    }
    .board > .bcol {
      flex: none;
      min-width: 0;
      min-height: auto;
    }
    .well {
      flex: none;
      overflow-y: visible;
      contain: none;
    }
  }
  @container (max-width: 419px) {
    .lanetabs {
      flex: none;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }
    .board {
      display: flex;
      flex-direction: column;
      min-height: 170px;
    }
    .bcol:not(.tabsel),
    .bcol-head {
      display: none;
    }
  }
  .lanetab {
    --lane-solid: var(--ink-soft);
    --lane-ink: var(--invert-ink);
    --lane-text: var(--ink-soft);
    --lane-bg: var(--bg-tint);
    --lane-line: var(--line);
    min-height: 32px;
    padding: 2px 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 2px 6px;
    font: 700 12px var(--font);
    line-height: 1.15;
    text-align: center;
    color: var(--lane-text);
    background: var(--lane-bg);
    border: 1px solid var(--lane-line);
    border-radius: 10px;
    cursor: pointer;
  }
  .lanetab.on {
    color: var(--lane-ink);
    background: var(--lane-solid);
    border-color: var(--lane-solid);
  }
  .lanetab-count {
    font-size: 11px;
  }
</style>
