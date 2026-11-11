<!--
  The volunteer view's header: the campaign's title with the viewer's own
  standing below it, the campaign's progress, and the View score button.
-->
<script lang="ts">
  import ProgressBar from "$lib/components/ProgressBar.svelte";

  let {
    name,
    standing,
    done,
    total,
    canViewScore,
    scoreHint,
    viewScoreButton = $bindable(),
    onviewscore,
  }: {
    /** The campaign's title, else its repository name. */
    name: string;
    /** The viewer's standing line; '' hides it. */
    standing: string;
    done: number;
    total: number;
    canViewScore: boolean;
    scoreHint: string;
    viewScoreButton?: HTMLButtonElement;
    onviewscore: () => void;
  } = $props();
</script>

<div class="volhead">
  <div class="voltitle">
    <h1 title={name}>{name}</h1>
    {#if standing}
      <span class="volstanding">{standing}</span>
    {/if}
  </div>
  <span class="volprogress">
    <ProgressBar {done} {total} />
  </span>
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

<style>
  .volhead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    /* The header follows the row's width instead of contributing its own —
       a long title wraps rather than widening the group. */
    width: 0;
    min-width: 100%;
    box-sizing: border-box;
  }
  .volhead h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
  }
  .voltitle {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .volstanding {
    font-size: 12px;
    color: var(--ink-soft);
  }
  /* The campaign's progress: a bar beside the count. */
  .volprogress {
    flex: none;
    --track-w: 140px;
  }
  /* Narrow column: the header wraps its title over the count. */
  @container (max-width: 700px) {
    /* Two lines: the title beside the score button, the viewer's standing
       beside the progress. */
    .volhead {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 12px;
    }
    .voltitle {
      display: contents;
    }
    .volhead h1 {
      grid-area: 1 / 1;
      align-self: center;
      font-size: 20px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .scorebtn {
      grid-area: 1 / 2;
    }
    .volstanding {
      grid-area: 2 / 1;
      align-self: center;
    }
    .volprogress {
      grid-area: 2 / 2;
      justify-self: end;
    }
    .volprogress {
      --track-w: 72px;
    }
  }
</style>
