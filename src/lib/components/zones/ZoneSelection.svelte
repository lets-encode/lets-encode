<!--
  The measure correction's Selection tab: the boxes selected together with
  their actions; or the selected box as the heading (for a measure with its
  number field), where it is and previous and next, its actions and, for a
  measure, its breaks, repeats and signs; in the instruments step why and
  how the staves are named; else how to select a box.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import SelectionPanel from "$lib/components/SelectionPanel.svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import { MAX_ANCHOR_LENGTH } from "$lib/campaign-submit.ts";
  import {
    boxNameOf,
    boxNamesOf,
    itemName,
    type Layer,
  } from "$lib/zones/edit-pages.ts";
  import { MOD, NAMING_WHY, namingSteps } from "$lib/zones/editor-help.ts";
  import type { ZoneEditor, ZonePages } from "$lib/zones/zone-pages.svelte.ts";
  import type { BoxSelection } from "$lib/zones/box-selection.svelte.ts";
  import MeasureDetails from "./MeasureDetails.svelte";

  let {
    editor: ed,
    model,
    sel,
    tool,
    step4,
    canEdit,
    coarse,
    docked,
    oncompose,
  }: {
    editor: ZoneEditor;
    model: ZonePages;
    sel: BoxSelection;
    /** The layer the pointer edits. */
    tool: Layer;
    /** The instruments step is in view. */
    step4: boolean;
    canEdit: boolean;
    /** A touch screen. */
    coarse: boolean;
    /** The side panel is docked as a sheet below the pages. */
    docked: boolean;
    /** Opens the panel's comment field. */
    oncompose: () => void;
  } = $props();

  const pages = $derived(model.pages);
  const selectedItem = $derived(sel.selectedItem);
  const groupZs = $derived(sel.groupZs);
  const selectedLabel = $derived(sel.selectedLabel);
  const boxName = $derived(boxNameOf(tool));
  const boxNames = $derived(boxNamesOf(tool));
  // The active layer's glyph in the side panel's heading.
  const toolGlyph = $derived(
    tool === "staves"
      ? { kind: "staff" as const, tone: "var(--ink-staff)" }
      : tool === "grandstaves"
        ? { kind: "grand" as const, tone: "var(--ink-grand)" }
        : { kind: "measure" as const, tone: "var(--ink-measure)" },
  );
</script>

<!-- A measure's number field: typing overrides the automatic number. -->
{#snippet numberInput(p: number, z: number)}
  {@const zone = pages[p].zones[z]}
  <input
    class="selnum"
    maxlength={MAX_ANCHOR_LENGTH}
    value={zone.override ?? zone.label}
    oninput={(e) => model.setLabel(p, z, (e.target as HTMLInputElement).value)}
    onchange={() => ed.commit()}
    title="Type to override the automatic number, e.g. 10a. The following measures count on from it."
  />
{/snippet}

<!-- The selected box's controls: the box as the heading (for a measure
     with its number field), where it is and previous and next; for a
     measure, below its actions, its breaks, repeats and signs. -->
<!-- Select several, on a touch screen: a tap on a box adds it to the
     selection or takes it out. With a mouse Shift+click and Shift+drag
     do this. -->
<!-- The edit actions on one selected box. -->
{#snippet editActions()}
  <button
    type="button"
    class="btn"
    onclick={sel.newBox}
    title={`New ${boxName} beside this one (N)`}
    ><Icon name="plus" />New {boxName}</button
  >
  <button
    type="button"
    class="btn btn-danger"
    onclick={() => ed.deleteSelection()}
    aria-label={`Delete the ${boxName}`}
    title={`Delete the ${boxName}`}><Icon name="trash" />Delete</button
  >
{/snippet}

{#if selectedItem && groupZs.length}
  <SelectionPanel
    glyph={toolGlyph.kind}
    tone={toolGlyph.tone}
    page={selectedItem.p}
    ondeselect={coarse && !(docked && canEdit)
      ? () => ed.select(0, null)
      : undefined}
    deselectTitle={`Deselect the ${boxNames}`}
  >
    {#snippet name()}{groupZs.length} {boxNames}{/snippet}
    {#snippet actions()}
      <button
        type="button"
        class="btn"
        onclick={() => ed.duplicate()}
        title={`Copy the ${groupZs.length} ${boxNames} below or beside them (${MOD}drag one of them copies them to where you drop it)`}
        ><Icon name="copy" />Duplicate</button
      >
      <button
        type="button"
        class="btn btn-danger"
        onclick={() => ed.deleteSelection()}
        aria-label={`Delete the ${groupZs.length} ${boxNames}`}
        title={`Delete the ${groupZs.length} ${boxNames}`}
        ><Icon name="trash" />Delete</button
      >
    {/snippet}
  </SelectionPanel>
{:else if selectedItem}
  {@const { p, z } = selectedItem}
  <SelectionPanel
    glyph={toolGlyph.kind}
    tone={toolGlyph.tone}
    page={p}
    item={boxName}
    onstep={(dir) => sel.stepSelection(dir)}
    canStep={(dir) => (dir < 0 ? sel.hasPrev : sel.hasNext)}
    keys={["A", "D"]}
    actions={canEdit ? editActions : undefined}
    oncomment={selectedLabel && auth.user ? () => oncompose() : undefined}
    commentTitle={`Comment on measure ${selectedLabel}`}
    ondeselect={coarse && !(docked && canEdit)
      ? () => ed.select(0, null)
      : undefined}
    deselectTitle={`Deselect the ${boxName}`}
  >
    {#snippet name()}
      {#if tool === "measures" && canEdit}
        <label class="selnumlabel">Measure {@render numberInput(p, z)}</label>
      {:else}
        {itemName(pages, tool, p, z)}
      {/if}
    {/snippet}
    {#snippet details()}
      {#if tool === "measures"}
        <MeasureDetails {model} {p} {z} {canEdit} />
      {/if}
    {/snippet}
  </SelectionPanel>
{:else if step4}
  <!-- The instruments step selects no boxes: why and how in short;
       the help (?) has the full text. -->
  <div class="namehelp">
    <p class="namewhy">{NAMING_WHY}</p>
    <ol>
      {#each namingSteps(canEdit) as line, i (i)}
        <li>{line}</li>
      {/each}
    </ol>
  </div>
{:else}
  <p class="selnone">
    {#if coarse && canEdit && ed.pickMode}
      Tap boxes to select them.
    {:else if coarse && canEdit && !ed.drawMode}
      <!-- One inline run: the flex .selnone drops the spaces around a
           bare icon. -->
      <span
        >Tap a box twice, or turn on Draw <Icon name="touch-box" size={16} />,
        to edit it.</span
      >
    {:else}
      {coarse ? "Tap" : "Click"} a box on the page to {canEdit
        ? "edit it"
        : "select it"}.
    {/if}
  </p>
{/if}

<style>
  /* "Measure" and the number field read as the heading's one name. */
  .selnumlabel {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .namehelp {
    padding: 12px 16px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-soft);
  }
  .namewhy {
    margin: 0 0 8px;
    color: var(--ink);
  }
  .namehelp ol {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
</style>
