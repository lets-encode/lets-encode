<!--
  The context strip over the board's lanes for the piece the board is
  scoped to: its first page, its name, page and measure counts with its
  tasks done, and its incipit, in the piece's colour.
-->
<script lang="ts">
  import PreviewFailed from "$lib/components/PreviewFailed.svelte";
  import { clipTitle, pieceLabel, pieceZone } from "$lib/campaign-tables.ts";
  import type { PieceRef } from "$lib/campaign-tables.ts";
  import type { PiecePreview } from "$lib/piece-previews.ts";

  let {
    piece,
    index,
    progress,
    preview,
    onretry,
  }: {
    piece: PieceRef;
    /** The piece's index among the campaign's pieces, for its colour. */
    index: number;
    progress: { done: number; total: number } | undefined;
    /** The piece's preview; null while it loads. */
    preview: PiecePreview | null;
    onretry: () => void;
  } = $props();
</script>

<div class="ctxstrip" style="--zone: var(--zone-{pieceZone(index)})">
  <span class="ctxpaper">
    {#if preview?.thumb}
      <img src={preview.thumb} alt="" loading="lazy" />
    {/if}
  </span>
  <div class="ctxinfo">
    <span class="ctxname" title={pieceLabel(piece)}
      >{clipTitle(pieceLabel(piece))}</span
    >
    <span class="ctxmeta"
      >{preview?.pageMeasures.length
        ? `${preview.pageMeasures.length} page${preview.pageMeasures.length === 1 ? "" : "s"} · ${preview.pageMeasures.reduce((a, b) => a + b, 0)} measures · `
        : ""}{progress?.done ?? 0} of {progress?.total ?? 0} done</span
    >
  </div>
  <div class="ctxincipit">
    {#if preview?.incipit}
      {@html preview.incipit}
    {:else if preview?.failed}
      <PreviewFailed onretry={() => onretry()} />
    {:else if preview?.incipitPending}
      <span class="ctxincnote">incipit appears after the setup tasks</span>
    {/if}
  </div>
</div>

<style>
  /* The scoped piece's preview over the columns. */
  .ctxstrip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    background: color-mix(in srgb, var(--zone) 8%, var(--card));
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    padding: 10px 16px;
    box-shadow: var(--shadow-sm);
  }
  .ctxpaper {
    flex: none;
    width: 36px;
    height: 47px;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
  }
  .ctxpaper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .ctxinfo {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ctxname {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .ctxmeta {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .ctxincipit {
    flex: 1;
    min-width: 0;
    height: 34px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 10px;
    display: flex;
    align-items: center;
    overflow: hidden;
  }
  .ctxincipit :global(svg) {
    height: 100%;
    width: auto;
    max-width: 100%;
  }
  /* A phone-width view: the strip is the piece's name and counts. */
  @container view (max-width: 700px) {
    .ctxpaper,
    .ctxincipit {
      display: none;
    }
  }
  .ctxincnote {
    font-size: 11px;
    color: var(--ink-faint);
  }
</style>
