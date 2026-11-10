<!--
  The score staves of an encoding alignment, top to bottom: per score staff
  the file staff it takes, or none. With `fixed` (an OMR-prepared piece) the
  number and order of the score staves are the layout's; otherwise rows can
  be moved (HandleReorder), removed and added. The file staves without a
  place are listed below, each with a button that places it. Read-only
  without `canEdit`, with the rows that differ from `automatic` marked.
-->
<script lang="ts">
  import type { FileStaff } from "$lib/encoding-merge.ts";
  import {
    chooseScoreStaff,
    placeFileStaff,
    unusedFileStaves,
  } from "$lib/encoding-align.ts";
  import type { StaffModel } from "$lib/mei-facsimile.ts";
  import { clefGlyph } from "$lib/staff-edit.ts";
  import { HandleReorder } from "$lib/handle-reorder.svelte.ts";
  import Icon from "./Icon.svelte";
  import MusicGlyph from "./MusicGlyph.svelte";

  let {
    staves,
    fileStaves,
    names,
    automatic = null,
    fixed,
    canEdit,
    chosen,
    onchange,
  }: {
    /** The file staff (1-based) per score staff, null for an empty staff. */
    staves: (number | null)[];
    fileStaves: FileStaff[];
    /** Per score staff, the layout's instrument name ('' for none); null for none at all. */
    names: string[] | null;
    /** The automatic score staves, for marking the rows that differ; null marks none. */
    automatic?: (number | null)[] | null;
    /** The number and order of the score staves are fixed. */
    fixed: boolean;
    canEdit: boolean;
    /** The score staves were chosen by hand. */
    chosen: boolean;
    /** The new score staves; undefined: placed automatically. */
    onchange: (staves: (number | null)[] | undefined) => void;
  } = $props();

  const fileStaff = (s: number | null) =>
    s === null ? undefined : fileStaves[s - 1];
  const clefWord = (f: FileStaff) =>
    f.clefShape === "perc"
      ? "percussion"
      : f.clefShape === "TAB"
        ? "tablature"
        : `${f.clefShape} clef`;
  const fileText = (f: FileStaff) =>
    [`File staff ${f.n}`, f.label, clefWord(f)].filter(Boolean).join(" · ");
  // A file staff carries no clef displacement or notation type; its glyph is
  // that of the plain clef on its line.
  const glyphOf = (f: FileStaff | undefined) =>
    f
      ? clefGlyph({
          ...f,
          clefDis: "",
          clefDisPlace: "",
          lines: 5,
          notationType: "",
        } satisfies StaffModel)
      : undefined;
  const nameOf = (t: number) => {
    const f = fileStaff(staves[t]);
    return names?.[t] || (f ? f.label || `Staff ${t + 1}` : "Empty staff");
  };

  const unused = $derived(unusedFileStaves(staves, fileStaves.length));
  const hasEmpty = $derived(staves.includes(null));

  let announcement = $state("");
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= staves.length) return;
    reorder.drop();
    const next = [...staves];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    onchange(next);
    announcement = `Staff ${from + 1} moved to place ${to + 1} of ${staves.length}.`;
  }
  function remove(t: number) {
    reorder.drop();
    onchange(staves.filter((_, i) => i !== t));
  }

  let list = $state<HTMLOListElement | null>(null);
  const reorder = new HandleReorder({
    rows: () => [...(list?.children ?? [])] as HTMLElement[],
    scroller: () => {
      let scroller = list?.parentElement ?? null;
      while (
        scroller &&
        !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      )
        scroller = scroller.parentElement;
      return scroller;
    },
    handle: (i) => list?.querySelectorAll<HTMLElement>(".grip")[i],
    count: () => staves.length,
    keyOf: (i) => String(i),
    move,
  });
  const handleTitle = (i: number) =>
    reorder.picked < 0
      ? "Drag to move this staff. Or click it, then click the staff whose place it takes. The arrow keys move it up and down."
      : reorder.picked === i
        ? "Click again to leave this staff where it is."
        : `Click to move staff ${reorder.picked + 1} here.`;
</script>

<div class="alignstaves">
  <p class="selgroup">Score staves, top to bottom</p>
  <ol class="rows" bind:this={list}>
    {#each staves as s, t (t)}
      {@const f = fileStaff(s)}
      {@const glyph = glyphOf(f)}
      <li
        class="row"
        class:dragged={reorder.dragging === t && reorder.picked < 0}
        class:picked={reorder.picked === t}
      >
        {#if canEdit && !fixed && staves.length > 1}
          <button
            type="button"
            class="grip"
            class:target={reorder.picked >= 0 && reorder.picked !== t}
            aria-label={`Staff ${t + 1}: move`}
            aria-pressed={reorder.picked === t}
            title={handleTitle(t)}
            onpointerdown={(e) => reorder.down(t, e)}
            onpointermove={(e) => reorder.pointerMove(e)}
            onpointerup={() => reorder.up()}
            onpointercancel={() => reorder.up()}
            onclick={() => reorder.click(t)}
            onkeydown={(e) => reorder.key(t, e)}
          >
            <Icon name="grip" />
          </button>
        {/if}
        <span class="no">{t + 1}</span>
        <span class="clef"
          >{#if glyph}<MusicGlyph name={glyph} />{/if}</span
        >
        <span class="name" class:empty={!f && !names?.[t]}>{nameOf(t)}</span>
        {#if !canEdit && automatic && automatic[t] !== s}
          <span
            class="chip chip-note"
            title="This staff differs from the automatic placement"
            >changed</span
          >
        {/if}
        <div class="line">
          {#if canEdit}
            <select
              class="ctl"
              value={s === null ? "" : String(s)}
              onchange={(e) => {
                const v = e.currentTarget.value;
                onchange(
                  chooseScoreStaff(staves, t, v === "" ? null : Number(v)),
                );
              }}
              aria-label={`Staff ${t + 1}: from the file`}
              title="The file staff this staff takes. A file staff used by another staff swaps places with this one."
            >
              {#each fileStaves as option (option.n)}
                <option value={String(option.n)}>{fileText(option)}</option>
              {/each}
              <option value="">Empty</option>
            </select>
            {#if !fixed && staves.length > 1}
              <button
                type="button"
                class="btn btn-icon btn-danger"
                onclick={() => remove(t)}
                aria-label={`Remove staff ${t + 1}`}
                title="Remove this staff"><Icon name="trash" /></button
              >
            {/if}
          {:else}
            <span class="from">{f ? fileText(f) : "Empty"}</span>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
  <span class="vh" role="status">{announcement}</span>
  {#if canEdit && (!fixed || chosen)}
    <div class="selactions">
      {#if !fixed}
        <button
          type="button"
          class="btn"
          onclick={() => onchange([...staves, null])}
          title="Add an empty staff below the last one"
          ><Icon name="plus" />Add staff</button
        >
      {/if}
      {#if chosen}
        <button
          type="button"
          class="btn"
          onclick={() => onchange(undefined)}
          title="Let the alignment choose the file staff for every staff again"
          ><Icon name="wand" />Place automatically</button
        >
      {/if}
    </div>
  {/if}
  {#if unused.length}
    <p class="selgroup">Not used</p>
    <ul class="rows">
      {#each unused as n (n)}
        <li class="row unused">
          <span class="name">{fileText(fileStaves[n - 1])}</span>
          {#if canEdit}
            <button
              type="button"
              class="btn btn-icon"
              onclick={() => {
                const next = placeFileStaff(staves, n, !fixed);
                if (next) onchange(next);
              }}
              disabled={fixed && !hasEmpty}
              aria-label={`Use file staff ${n}`}
              title={hasEmpty
                ? "Put this file staff into the first empty staff"
                : fixed
                  ? "No staff is empty. Choose this file staff in a staff's list instead."
                  : "Add this file staff as a new staff below the last one"}
              ><Icon name="plus" /></button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .alignstaves {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  /* A score staff under a hairline: grip, number, clef and name, with its
     file staff below the name. */
  .row {
    display: grid;
    grid-template-columns: 12px 18px 18px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 6px;
    row-gap: 6px;
    padding: 8px 2px;
    border-radius: 8px;
    font-size: 13px;
  }
  .row + .row {
    border-top: 1px solid var(--line);
    border-radius: 0;
  }
  .row > :global(.grip) {
    grid-column: 1;
    grid-row: 1 / span 2;
  }
  .no {
    grid-column: 2;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .clef {
    grid-column: 3;
    display: flex;
    justify-content: center;
  }
  .name {
    grid-column: 4;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .name.empty {
    font-weight: 400;
    color: var(--ink-soft);
  }
  .line {
    grid-column: 2 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .line > .ctl {
    flex: 1 1 0;
    min-width: 0;
  }
  .from {
    color: var(--ink-soft);
  }
  .row.unused {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .row.unused .name {
    grid-column: 1;
    font-weight: 400;
  }
  .row.dragged {
    background: var(--accent-tint-strong);
    box-shadow: 0 2px 8px rgba(31, 36, 51, 0.14);
  }
  .row.picked {
    background: var(--accent-tint-strong);
    outline: 1.5px solid var(--accent);
  }
</style>
