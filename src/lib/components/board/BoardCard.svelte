<!--
  One task card in a board lane: its badges, title and summary, its piece
  while several share the board, the review count with one mark per slot,
  the run state of a submission, who works on it or what it waits for, and
  its open change requests and comments. Selecting it opens the task.
-->
<script lang="ts">
  import SlotMark from "$lib/components/SlotMark.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import {
    cardSummary,
    doneLabel,
    initialOf,
    reviewWaitLabel,
    stageOf,
  } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import { clipTitle } from "$lib/campaign-tables.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  let {
    card,
    repoId,
    viewer,
    logins,
    selected,
    completedTask,
    recentlyFinished,
    pieceListed,
    zone,
    reviewExpiry,
    onopen,
  }: {
    card: BoardCard;
    repoId: number;
    viewer: string;
    logins: Record<string, string>;
    /** The side panel shows this card's task. */
    selected: boolean;
    /** The task mei-friend just reported complete, else null. */
    completedTask: string | null;
    /** The viewer's submission just moved this task. */
    recentlyFinished: boolean;
    /** The card names its piece. */
    pieceListed: boolean;
    /** The piece's colour index. */
    zone: number;
    /** When the claim on a held review slot expires. */
    reviewExpiry: (task: string, sub: string, user: string) => string;
    onopen: (task: string) => void;
  } = $props();
</script>

<!-- A focusable div, not a <button>: the run state inside
     it can render a PR link, which HTML does not allow
     nested in a button. -->
<div
  class="card col-{card.column}"
  class:justmoved={recentlyFinished || card.task === completedTask}
  class:paneled={selected}
  aria-current={selected ? "true" : undefined}
  class:failtint={card.counts.fails > 0 && card.column !== "done"}
  role="button"
  tabindex="0"
  onclick={() => onopen(card.task)}
  onkeydown={(e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onopen(card.task);
    }
  }}
  title="Open this task"
  data-stage={stageOf(card)}
>
  {#if card.nextUp && !completedTask && !pendingVerdicts.taskProcessing(card.task, repoId)}
    <span class="taskbadge edge">your next task</span>
  {/if}
  {#if card.task === completedTask}
    <span class="taskbadge done edge right">just completed</span>
  {:else if recentlyFinished}
    <span class="taskbadge done edge right">just submitted</span>
  {/if}
  <div class="card-title">
    {card.description}{#if card.scope}<span class="card-scope"
        >{` · ${card.scope}`}</span
      >{/if}
  </div>
  {#if cardSummary(card)}
    <p class="card-what">{cardSummary(card)}</p>
  {/if}
  {#if pieceListed}
    <div class="card-piece" style="--zone: var(--zone-{zone})">
      <span class="piece-dot"></span>
      <span class="card-pname" title={card.piece}>{clipTitle(card.piece)}</span>
    </div>
  {/if}
  <!-- A submission's run state takes the review
       count's place while it shows. -->
  {#if card.column === "validation" && !pendingVerdicts.forTask(card.task, repoId)}
    <div class="card-type">
      {reviewWaitLabel(
        card.passes,
        card.threshold,
        card.slots.filter(
          (s) => s.key === "review" && viewer !== "" && s.user === viewer,
        ).length,
        card.slots.filter(
          (s) => s.key === "review" && !(viewer !== "" && s.user === viewer),
        ).length,
        card.slots.some((s) => s.needsAnother),
      )}
      <span class="card-dots">
        {#each card.slots as slot (slot.label)}
          <SlotMark key={slot.key} who={slot.who} />
        {/each}
      </span>
    </div>
  {/if}
  <TaskRunState task={card.task} {repoId} pill short />
  {#if card.column === "blocked"}
    <div class="card-foot">
      waits for <strong>{card.waitsFor}</strong>
    </div>
  {:else if card.column === "encoding" && card.worker}
    <div class="card-worker">
      <span class="avatar">{initialOf(card.worker.login)}</span>
      <span class="worker-line"
        >{card.worker.login} · {card.worker.expires}</span
      >
    </div>
  {:else if card.column === "validation"}
    <!-- Who holds each review slot, as the
         encoding lane shows its worker. -->
    {#each card.slots.filter((s) => s.key === "review" && s.user) as slot (slot.label)}
      <div class="card-worker">
        <span class="avatar review">{initialOf(handle(logins, slot.user))}</span
        >
        <span class="worker-line review"
          >{handle(logins, slot.user)} · {reviewExpiry(
            card.task,
            slot.sub,
            slot.user,
          )}</span
        >
      </div>
    {/each}
  {:else if card.column === "done"}
    <div class="card-done">
      <img class="hand-done" src="/green-hand.svg" alt="" />
      {doneLabel(card)}
    </div>
  {/if}
  {#if card.column !== "done" && card.counts.fails + card.counts.comments > 0}
    <div class="card-chips">
      {#if card.counts.fails > 0}
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
    </div>
  {/if}
</div>

<style>
  .card {
    position: relative;
    /* A flex column at its content's height. */
    display: flex;
    flex-direction: column;
    text-align: left;
    font-family: inherit;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
    flex: none;
    box-sizing: border-box;
  }
  /* The card the side panel shows. */
  .card.paneled {
    background: var(--info-bg);
    border-color: var(--info-line);
  }
  @media (hover: hover) {
    .card:hover {
      border-color: var(--accent);
    }
  }
  .card.col-blocked {
    opacity: 0.8;
    box-shadow: none;
  }
  .card.col-encoding {
    border: 1.5px solid var(--info-line);
  }
  .card.col-validation {
    border: 1.5px solid var(--warn-line);
  }
  .card.col-done {
    box-shadow: none;
  }
  /* Before .card.failtint: a recorded fail outweighs the finished highlight. */
  .card.justmoved {
    border-color: var(--ok-line);
    background: var(--ok-wash);
  }
  .card.failtint {
    background:
      linear-gradient(var(--danger-wash), var(--danger-wash)), var(--card);
    border-color: var(--danger-line);
  }
  /* The card the side panel shows: an outline the stage and fail tints
     cannot override. */
  .card.paneled {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The next task is marked by its badge (.taskbadge, ui.css) only, on
     the card's top edge: the next task on the left, a finished one on the
     right. */
  .edge {
    position: absolute;
    top: -9px;
    left: 12px;
  }
  .edge.right {
    left: auto;
    right: 12px;
  }
  .card-title {
    font-size: 14px;
    line-height: 1.25;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .card-scope {
    color: var(--ink-soft);
  }
  .card-what {
    margin: 3px 0 0;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--ink-soft);
  }
  /* On a touch screen the cards are larger targets with larger type. */
  @media (pointer: coarse) {
    .card {
      padding: 12px 14px;
    }
    .card-title {
      font-size: 15px;
    }
    .card-what {
      font-size: 13.5px;
    }
  }
  /* The piece line, shown where several pieces share the board. A long
     title is cut to one line; the full title is its tooltip. */
  .card-piece {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--ink-soft);
  }
  .card-pname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The piece's colour, as on its dot in the piece rail. */
  .piece-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone);
  }
  .card.col-blocked .card-title,
  .card.col-done .card-title {
    color: var(--ink-soft);
  }
  /* The review count with one dot per review slot. */
  .card > :global(.live) {
    margin-top: 5px;
  }
  .card-type {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 2px;
  }
  .card-foot {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 5px;
    border-top: 1px solid var(--hairline);
    padding-top: 5px;
  }
  .card-worker {
    display: flex;
    align-items: center;
    gap: 7px;
    padding-top: 4px;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-btn);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .worker-line {
    font-size: 11.5px;
    color: var(--info);
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A held review slot, in the review stage's colour. */
  .avatar.review {
    background: var(--warn-solid);
  }
  .worker-line.review {
    color: var(--warn);
  }
  .card-dots {
    display: flex;
    gap: 4px;
  }
  .card-chips {
    display: flex;
    gap: 6px;
    margin-top: 5px;
    border-top: 1px solid var(--hairline);
    padding-top: 5px;
    flex-wrap: wrap;
  }
  .card-done {
    font-size: 11.5px;
    color: var(--ok);
    font-weight: 600;
    padding-top: 4px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .hand-done {
    height: 12px;
    flex: none;
  }
</style>
