<!--
  One campaign in the overview listing: a full-width row of three zones —
  facsimile spine, title/byline/progress, and the suggested next task with
  its claim action. The row links to the campaign; only the claim button
  acts. The row adapts to the width of the `shelf` container it sits in:
  below 600px the next task moves under the campaign as a strip.
-->
<script lang="ts">
  import {
    claimLabel,
    preTaskHref,
    reviewHref,
    workPlace,
  } from "$lib/campaign-graph.ts";
  import Icon from "$lib/components/Icon.svelte";
  import { elapsed } from "$lib/campaign-board.ts";
  import { attentionCount, nextTask } from "$lib/campaign-stats.ts";
  import type { CampaignStats, NextTask } from "$lib/campaign-stats.ts";
  import { login } from "$lib/auth.svelte.ts";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { piecePreview } from "$lib/piece-previews.ts";
  import type { PiecePreview } from "$lib/piece-previews.ts";
  import { systemThumb } from "$lib/system-thumbs.ts";

  let {
    stats,
    owned = false,
    viewer,
    busy,
    onact,
  }: {
    stats: CampaignStats;
    owned?: boolean;
    viewer: string;
    busy: boolean;
    /** Act on the row's next task: claim it (action 'encode' or 'review'),
        or open held encoding work in the editor (action 'continue'). */
    onact: (stats: CampaignStats, next: NextTask) => void;
  } = $props();

  const next = $derived(nextTask(stats, viewer));

  const pct = $derived(
    stats.total ? Math.round((stats.done / stats.total) * 100) : 0,
  );
  const activity = $derived.by(() => {
    if (stats.lastActivity) {
      const e = elapsed(stats.lastActivity);
      return e === "now" ? "active just now" : `active ${e} ago`;
    }
    if (stats.createdAt) return `created ${elapsed(stats.createdAt)} ago`;
    return "no activity yet";
  });
  const attention = $derived(owned ? attentionCount(stats) : 0);
  // "Yours" renders separately, in the owner colour, after the composer.
  const bylineRest = $derived(
    [owned ? "" : `by ${stats.owner}`, activity].filter(Boolean).join(" · "),
  );

  // The first piece's preview, for its first page's first system; "No
  // preview" while the page has no measures. Loaded when the row mounts; the
  // show-more paging keeps unmounted rows from loading.
  const piecePath = $derived(stats.taskDefs.find((t) => t.fragment)?.fragment);
  let preview = $state<PiecePreview | null>(null);
  // Raised by "Try again" to load a failed preview anew.
  let attempt = $state(0);
  $effect(() => {
    const path = piecePath;
    void attempt;
    if (!path) return;
    piecePreview(readForge(), stats.owner, stats.repo, path, false).then(
      (p) => {
        preview = p;
      },
    );
  });

  // A small image of the first page's first system, cut in the browser and
  // kept there (system-thumbs.ts); null when it could not be cut.
  let thumb = $state<{ url: string } | null>(null);
  let thumbDone = $state(false);
  $effect(() => {
    const page = preview?.pages.find((p) => p.url);
    void attempt;
    if (!page?.system) return;
    let url = "";
    let live = true;
    systemThumb(page).then((blob) => {
      if (!live) return;
      if (blob) {
        url = URL.createObjectURL(blob);
        thumb = { url };
      }
      thumbDone = true;
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  });
  const hasSystem = $derived(
    Boolean(preview?.pages.find((p) => p.url)?.system),
  );
  const retryPreview = () => {
    preview = null;
    thumb = null;
    thumbDone = false;
    attempt++;
  };

  const claimable = (n: NextTask): boolean =>
    n.action === "encode" ||
    n.action === "review" ||
    (n.action === "continue" && n.kind !== "review" && !n.pre);

  const actLabel = (n: NextTask): string => {
    if (n.action === "review") return "Claim to review";
    if (n.action === "continue") return "Open in mei-friend";
    return claimLabel(n.locator);
  };
  const claimTip = (n: NextTask): string =>
    n.action === "continue"
      ? "Opens the task you hold in mei-friend."
      : `Reserves this ${n.action === "review" ? "review" : "task"} for you for a limited time. Abandon gives it back.`;
</script>

<div class="shelfrow">
  <div class="rowmain">
    <span class="spine">
      {#if thumb}
        <a
          class="paper"
          href={`/${stats.name}`}
          tabindex="-1"
          aria-hidden="true"><img src={thumb.url} alt="" /></a
        >
      {:else if preview?.failed || (hasSystem && thumbDone)}
        <button
          type="button"
          class="nopreview failed"
          title="Load the preview again"
          onclick={retryPreview}
          >Preview failed<span class="retry">Try again</span></button
        >
      {:else if (preview && !hasSystem) || !piecePath}
        <span class="nopreview">No preview</span>
      {/if}
    </span>
    <a class="rowlink" href={`/${stats.name}`}>
      <span class="titleline">
        <span class="title">{stats.title}</span>
        {#if attention > 0}
          <span class="attn"
            >{attention} change{attention === 1 ? "" : "s"} requested</span
          >
        {/if}
      </span>
      <span class="byline"
        >{#if stats.composer}{stats.composer}{" · "}{/if}{#if owned}<span
            class="yours">Yours</span
          >{" · "}{/if}{bylineRest}</span
      >
      <span class="progress">
        <span class="bar"
          ><span class="fill" style={`width:${pct}%`}></span></span
        >
        <span class="count">{stats.done} of {stats.total} tasks</span>
      </span>
    </a>
  </div>
  <div class="nextcol" class:idle={!next}>
    {#if next}
      <span class="nexttitle" title={next.title}>{next.title}</span>
      {#if claimable(next)}
        <button
          type="button"
          class="btn btn-primary {next.action === 'review'
            ? 'btn-review'
            : next.pre
              ? 'btn-pre'
              : 'btn-enc'}"
          title={claimTip(next)}
          disabled={busy ||
            pendingVerdicts.taskProcessing(next.task, stats.repoId)}
          onclick={() => onact(stats, next)}
          >{actLabel(next)}{#if next.action !== "review" && !next.pre}<Icon
              name="external"
            />{/if}</button
        >
      {:else if next.action === "continue"}
        <a
          class="btn"
          href={next.kind === "review"
            ? reviewHref(stats.name, next.locator, next.task)
            : preTaskHref(stats.name, next.locator, next.task)}
          >{next.kind === "review"
            ? "Open review"
            : `Open ${workPlace(next.locator)}`}</a
        >
      {:else if !viewer}
        <button type="button" class="linkish" onclick={() => login()}
          >Log in to claim</button
        >
      {:else}
        <span class="wait"
          ><Icon name="clock" size={13} />{next.kind === "review"
            ? "Waiting for another reviewer"
            : "Open to other volunteers"}</span
        >
      {/if}
    {:else}
      <span class="nonote"
        >{stats.total > 0 && stats.done === stats.total
          ? "Campaign done"
          : "No open tasks"}</span
      >
    {/if}
  </div>
</div>

<style>
  .shelfrow {
    display: flex;
    align-items: stretch;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  @media (hover: hover) {
    .shelfrow:hover {
      border-color: var(--info-line);
      box-shadow: var(--shadow-md);
    }
  }
  .rowmain {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 14px 24px 14px 14px;
  }
  /* A landscape strip on the mat: the first system of the first page. */
  .spine {
    flex: none;
    width: 184px;
    height: 64px;
    padding: 6px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--mat);
    border-radius: 8px;
  }
  .paper {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    background: var(--facsimile-paper);
    box-shadow: var(--shadow-sm);
    border-radius: 2px;
    overflow: hidden;
  }
  .paper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: left center;
  }
  .nopreview {
    font-size: 12px;
    line-height: 1.3;
    text-align: center;
    padding: 0 6px;
    color: var(--ink-soft);
  }
  button.nopreview {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 24px;
    font: inherit;
    font-size: 12px;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .nopreview.failed {
    font-weight: 600;
    color: var(--danger);
  }
  .retry {
    color: var(--link);
  }
  @media (hover: hover) {
    button.nopreview:hover .retry {
      text-decoration: underline;
    }
  }
  .rowlink {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--ink);
    text-decoration: none;
  }
  .titleline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    min-width: 0;
  }
  .title {
    min-width: 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .attn {
    flex: none;
    font-size: 12px;
    font-weight: 600;
    line-height: 19px;
    padding: 0 9px;
    border-radius: 999px;
    color: var(--danger);
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
  }
  .byline {
    font-size: 13px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .yours {
    font-weight: 600;
    color: var(--owner);
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 560px;
  }
  .bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    overflow: hidden;
  }
  /* The dark theme's tint sits too close to the card for an empty track. */
  :global([data-theme="dark"]) .bar {
    background: var(--line-strong);
  }
  .fill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .count {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .nextcol {
    flex: none;
    width: 300px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: 8px;
    padding: 16px 22px;
    border-left: 1px solid var(--line);
    box-sizing: border-box;
  }
  /* A long claim label wraps inside the column instead of overflowing it. */
  .nextcol .btn {
    max-width: 100%;
    white-space: normal;
    text-align: left;
  }
  .nexttitle {
    max-width: 100%;
    font-size: 13px;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .linkish {
    min-height: 24px;
    padding: 0;
    font: 600 12.5px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    cursor: pointer;
  }
  @media (hover: hover) {
    .linkish:hover {
      text-decoration: underline;
    }
  }
  .wait {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--ink-faint);
  }
  .nonote {
    font-size: 13px;
    color: var(--ink-faint);
  }
  @container shelf (max-width: 900px) {
    .rowmain {
      gap: 16px;
      padding: 12px 18px 12px 12px;
    }
    .spine {
      width: 148px;
      height: 56px;
    }
    .nextcol {
      width: 272px;
      padding: 14px 18px;
    }
  }
  /* Narrow: the next task becomes a strip under the campaign; a campaign
     with no open task drops the strip. */
  @container shelf (max-width: 600px) {
    .shelfrow {
      flex-direction: column;
    }
    .rowmain {
      align-items: flex-start;
      gap: 12px;
      padding: 14px;
    }
    .spine {
      width: 112px;
      height: 48px;
      padding: 5px;
      border-radius: 6px;
    }
    .nopreview {
      padding: 0 3px;
    }
    .title {
      -webkit-line-clamp: 3;
      line-clamp: 3;
    }
    .byline {
      white-space: normal;
    }
    .nextcol {
      width: auto;
      padding: 12px 14px;
      border-left: 0;
      border-top: 1px solid var(--line);
    }
    .nextcol.idle {
      display: none;
    }
  }
</style>
