<!--
  The task-anchored view of a background GitHub run: while a submission opened for
  this task is being processed, the task's kanban card, its panel and the
  editor views show a compact live state that settles in place when the
  verdict lands. Rejections additionally take the viewport over
  (PendingVerdicts.svelte).
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  let {
    task,
    pill = false,
    short = false,
    large = false,
  }: {
    /** The task id whose run state renders, e.g. "T0002". */
    task: string;
    /** Render as a pill (side panel status row, editor views) instead of a card badge. */
    pill?: boolean;
    /** Name the submission by its number alone, e.g. "processing #29…". */
    short?: boolean;
    /** Render at the next-task card's text size. */
    large?: boolean;
  } = $props();

  const entry = $derived(pendingVerdicts.forTask(task));
  const sub = $derived(short ? "" : "submission ");
</script>

<!-- A live region that is always present, so a run state appearing in it
     is announced; empty, it takes no room. -->
<div class="live" aria-live="polite">
  {#if entry}
    <div
      class="runstate {entry.state}"
      class:pill
      class:large
      title={short && entry.prNumber
        ? `submission #${entry.prNumber}`
        : undefined}
    >
      {#if entry.state === "opening"}
        <span class="spinner" aria-hidden="true"></span>
        <span>{short ? "opening…" : "opening the submission…"}</span>
      {:else if entry.state === "processing"}
        <span class="spinner" aria-hidden="true"></span>
        <span
          >processing
          <a
            href={entry.prUrl}
            target="_blank"
            rel="noreferrer"
            onclick={(e) => e.stopPropagation()}>{sub}#{entry.prNumber}</a
          >…</span
        >
      {:else if entry.state === "accepted"}
        <span class="mark" aria-hidden="true"
          ><Icon name="check" size={12} /></span
        >
        <span>{sub}#{entry.prNumber} accepted</span>
      {:else if entry.state === "timeout"}
        <span class="mark" aria-hidden="true">…</span>
        <span
          ><a
            href={entry.prUrl}
            target="_blank"
            rel="noreferrer"
            onclick={(e) => e.stopPropagation()}>{sub}#{entry.prNumber}</a
          >{short ? " still processing" : " is still being processed"}</span
        >
      {:else}
        <span class="mark" aria-hidden="true"
          ><Icon name="warning" size={12} /></span
        >
        <span
          >{entry.runFailed
            ? `run for ${sub}#${entry.prNumber} failed`
            : entry.prNumber
              ? `${sub}#${entry.prNumber} rejected`
              : "submission failed"}</span
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .live:empty {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .runstate {
    display: flex;
    align-items: center;
    margin-top: 6px;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .runstate.pill {
    margin-top: 0;
    padding: 3px 10px;
    /* Full pill on one line; a rounded box where the text wraps. */
    border-radius: 11px;
    font-size: 11.5px;
    line-height: 1.25;
    width: fit-content;
    max-width: 100%;
    box-sizing: border-box;
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
  }
  .runstate.pill .spinner {
    border-color: color-mix(in srgb, var(--st) 30%, var(--card));
    border-top-color: var(--st);
  }
  .runstate.large {
    margin-top: 0;
    font-size: 13px;
  }
  .runstate a {
    color: var(--link);
  }
  .runstate.accepted {
    color: var(--ok);
  }
  .runstate.accepted.pill {
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }
  .runstate.timeout {
    color: var(--warn);
  }
  .runstate.timeout.pill {
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .runstate.rejected {
    color: var(--danger);
  }
  .runstate.rejected.pill {
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }
  .mark {
    flex: none;
  }
</style>
