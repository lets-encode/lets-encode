<!--
  The selected item's block in the side panel's Selection tab (.selpanel,
  ui.css): its glyph, name and page, stepping to the previous and next item,
  then what the view says about it (`children`), its actions (the view's own,
  Comment, Deselect) and its properties (`details`). The keys named in
  `keys` go into the stepping buttons' titles.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import StepGlyph from "./StepGlyph.svelte";

  type GlyphKind = Parameters<typeof StepGlyph>[1]["kind"];
  let {
    glyph,
    tone,
    name,
    page,
    item,
    onstep,
    canStep,
    keys,
    actions,
    oncomment,
    commentTitle,
    ondeselect,
    deselectTitle,
    children,
    details,
  }: {
    glyph: GlyphKind;
    tone: string;
    /** The selection's name in the heading. */
    name: Snippet;
    /** The 0-based page; -1 when unknown. */
    page: number;
    /** What one selected item is called, e.g. "measure", for the stepping
        buttons. */
    item?: string;
    /** Select the item before (-1) or after (1); without it there is no
        stepping. */
    onstep?: (dir: -1 | 1) => void;
    canStep?: (dir: -1 | 1) => boolean;
    /** The keys that step back and on, e.g. ["A", "D"]. */
    keys?: [string, string];
    /** The view's own actions, before Comment. */
    actions?: Snippet;
    /** Opens the comment composer; without it there is no Comment button. */
    oncomment?: () => void;
    commentTitle?: string;
    /** Clears the selection; without it there is no Deselect button. */
    ondeselect?: () => void;
    deselectTitle?: string;
    /** What the view says about the selection, below the heading. */
    children?: Snippet;
    /** The selection's properties, below the actions. */
    details?: Snippet;
  } = $props();

  const stepTitle = (dir: -1 | 1) =>
    `${dir < 0 ? "Previous" : "Next"} ${item}${keys ? ` (${keys[dir < 0 ? 0 : 1]})` : ""}`;
</script>

<div class="selpanel">
  <div class="selhead">
    <span class="selname"
      ><StepGlyph kind={glyph} {tone} size={20} />{@render name()}</span
    >
    {#if page >= 0}<span class="selwhere">page {page + 1}</span>{/if}
    {#if onstep}
      <span class="selnav">
        {#each [-1, 1] as const as dir (dir)}
          <button
            type="button"
            class="btn btn-icon"
            onclick={() => onstep(dir)}
            disabled={!canStep?.(dir)}
            aria-label={`${dir < 0 ? "Previous" : "Next"} ${item}`}
            title={stepTitle(dir)}
            ><Icon name={dir < 0 ? "chevron-left" : "chevron-right"} /></button
          >
        {/each}
      </span>
    {/if}
  </div>
  {@render children?.()}
  {#if actions || oncomment || ondeselect}
    <div class="selactions">
      {@render actions?.()}
      {#if oncomment}
        <button
          type="button"
          class="btn"
          onclick={oncomment}
          aria-label={commentTitle}
          title={commentTitle}><Icon name="comment" />Comment</button
        >
      {/if}
      {#if ondeselect}
        <button
          type="button"
          class="btn"
          onclick={ondeselect}
          title={deselectTitle}><Icon name="close" />Deselect</button
        >
      {/if}
    </div>
  {/if}
  {@render details?.()}
</div>
