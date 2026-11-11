<!--
  The score setup's staves, step 1: a row per staff with its handle and
  number, the instrument, the clef and the transposition or the line count,
  and "Add staff" below. The staves of a grand staff (a brace of one
  instrument) stand in one box with a brace before them.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import GlyphSelect from "$lib/components/GlyphSelect.svelte";
  import MusicGlyph from "$lib/components/MusicGlyph.svelte";
  import StaffPitchSelects from "$lib/components/StaffPitchSelects.svelte";
  import StaffCustomPitch from "$lib/components/StaffCustomPitch.svelte";
  import { MAX_STAVES } from "$lib/setup/score-def.ts";
  import type { SetupModel } from "$lib/setup/setup-model.svelte.ts";
  import type { SetupPreview } from "$lib/setup/setup-preview.svelte.ts";
  import type { StaffListEditor } from "$lib/setup/staff-list.svelte.ts";
  import {
    CLEF_OPTIONS,
    COMMON_CLEFS,
    clefGlyph,
    clefOption,
    clefText,
    linesChoices,
    transposes,
    unpitched,
  } from "$lib/staff-edit.ts";

  let {
    model,
    editor,
    preview,
    canEdit,
    hasNotation,
  }: {
    model: SetupModel;
    editor: StaffListEditor;
    /** The pointed staff, coloured in the preview. */
    preview: SetupPreview;
    canEdit: boolean;
    /** Whether the piece holds notation, which fixes the staff count. */
    hasNotation: boolean | undefined;
  } = $props();

  const reorder = $derived(editor.reorder);
  const pitch = $derived(model.pitch);
  // The grand staves: the braces of one instrument that fit the staves.
  const grands = $derived(
    model.groups.filter(
      (g) =>
        g.symbol === "brace" &&
        g.oneInstrument &&
        g.start >= 1 &&
        g.start < g.end &&
        g.end <= model.staves.length,
    ),
  );
</script>

<ol class="staves" class:braced={grands.length > 0} bind:this={editor.list}>
  {#each model.staves as staff, i (i)}
    <li
      class="staffrow"
      class:gfirst={grands.some((g) => g.start === i + 1)}
      class:afterg={grands.some((g) => g.end === i)}
      style:grid-row={i + 1}
      class:transposing={!unpitched(staff) && transposes(staff)}
      class:pointed={preview.pointedStaff === i}
      class:dragged={reorder.dragging === i && reorder.picked < 0}
      class:picked={reorder.picked === i}
      {...preview.pointAt(i)}
    >
      {#if canEdit && model.staves.length > 1 && !hasNotation}
        <button
          type="button"
          class="grip staffgrip"
          class:target={reorder.picked >= 0 && reorder.picked !== i}
          style:grid-row="2 / span {pitch.value(staff) === 'other' &&
          !unpitched(staff)
            ? 2
            : 1}"
          aria-label={`Staff ${i + 1}: move`}
          aria-pressed={reorder.picked === i}
          title={editor.handleTitle(i)}
          onpointerdown={(e) => reorder.down(i, e)}
          onpointermove={(e) => reorder.pointerMove(e)}
          onpointerup={() => reorder.up()}
          onpointercancel={() => reorder.up()}
          onclick={() => reorder.click(i)}
          onkeydown={(e) => reorder.key(i, e)}
        >
          <Icon name="grip" />
        </button>
      {/if}
      <span class="staffno">{i + 1}</span>
      <div class="staffline">
        <input
          class="ctl grow"
          type="text"
          bind:value={staff.label}
          oninput={() => pitch.fillFromLabel(staff)}
          placeholder="Instrument"
          aria-label={`Staff ${i + 1}: instrument`}
          title="The instrument or voice name printed in front of this staff. Leave empty for none. A name with a pitch, like Clarinetto in B, sets the transposition."
        />
        {#if canEdit}
          <button
            type="button"
            class="btn btn-icon btn-danger"
            onclick={() => editor.removeStaff(i)}
            disabled={model.staves.length <= 1 || hasNotation}
            aria-label={`Remove staff ${i + 1}`}
            title={hasNotation
              ? "The staff count is fixed once the piece holds notation"
              : "Remove this staff"}><Icon name="trash" /></button
          >
        {/if}
      </div>
      <div class="staffline">
        <GlyphSelect
          class="ctl clef"
          options={clefOption(staff)
            ? CLEF_OPTIONS
            : [
                {
                  value: "",
                  label: clefText(staff),
                  glyph: clefGlyph(staff),
                },
                ...CLEF_OPTIONS,
              ]}
          top={COMMON_CLEFS}
          value={clefOption(staff)?.value ?? ""}
          onchange={(v) => model.setClef(staff, v)}
          label={`Staff ${i + 1}: clef`}
          title="The clef this staff opens with."
        />
        {#if unpitched(staff) && staff.notationType !== "tab.lute.german"}
          <select
            class="ctl lines"
            value={String(staff.lines)}
            onchange={(e) => {
              staff.lines = Number((e.target as HTMLSelectElement).value);
              // Keep the clef on the staff: centred on the lines
              // it actually has.
              staff.clefLine = Math.ceil(staff.lines / 2);
            }}
            aria-label={`Staff ${i + 1}: lines`}
            title="How many lines the staff has — one per string for a tablature, up to five for percussion."
          >
            {#each linesChoices(staff) as count (count)}
              <option value={String(count)}
                >{count} line{count === 1 ? "" : "s"}</option
              >
            {/each}
          </select>
        {:else if !unpitched(staff)}
          <StaffPitchSelects
            editor={pitch}
            {staff}
            scoreKey={model.keysig}
            name={`Staff ${i + 1}`}
          />
        {/if}
      </div>
      {#if pitch.value(staff) === "other" && !unpitched(staff)}
        <div class="staffline custom">
          <StaffCustomPitch editor={pitch} {staff} name={`Staff ${i + 1}`} />
        </div>
      {/if}
    </li>
  {/each}
  {#each grands as g (g)}
    <li
      class="grandbox"
      style:grid-row="{g.start} / {g.end + 1}"
      aria-hidden="true"
    >
      <span
        class="gbrace"
        title="A grand staff: these staves belong to one instrument."
        ><MusicGlyph name="brace" stretch /></span
      >
    </li>
  {/each}
</ol>
{#if canEdit}
  <button
    type="button"
    class="btn addbtn"
    onclick={() => editor.addStaff()}
    disabled={model.staves.length >= MAX_STAVES || hasNotation}
    title={hasNotation
      ? "The staff count is fixed once the piece holds notation"
      : "Add a staff below the last one."}><Icon name="plus" />Add staff</button
  >
{/if}

<style>
  .staves {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: grid;
    grid-template-columns: 0 minmax(0, 1fr);
  }
  /* With a grand staff, a column before the rows holds its brace. */
  .staves.braced {
    grid-template-columns: 16px minmax(0, 1fr);
  }
  /* A grand staff's box around the rows of its staves, drawn over them, with
     the brace in the column before them. Only the brace takes the pointer. */
  .grandbox {
    grid-column: 1 / -1;
    z-index: 1;
    display: flex;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    pointer-events: none;
  }
  .gbrace {
    width: 8px;
    margin: 8px 0 8px 5px;
    color: var(--ink-grand);
    pointer-events: auto;
  }
  /* A staff, as a row under a hairline: its number beside the instrument
     with the row's buttons, the clef, transposition and key below it, and
     the pitch fields of an unlisted transposition below that. */
  .staffrow {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    column-gap: 6px;
    row-gap: 6px;
    grid-column: 2;
    padding: 10px 2px 10px 6px;
    border-radius: 8px;
  }
  .staffrow + .staffrow {
    border-top: 1px solid var(--line);
    border-radius: 0;
  }
  /* The box's own border stands for the hairline at its top and below it. */
  .staffrow.gfirst,
  .staffrow.afterg {
    border-top-color: transparent;
  }
  .staffrow > .staffno {
    grid-column: 1;
    grid-row: 1;
    align-self: center;
    width: auto;
    text-align: center;
  }
  .staffrow > .staffline {
    grid-column: 2;
  }
  .staffrow > .staffline + .staffline {
    gap: 4px;
  }
  /* A transposing instrument's staff, in a tint of its own. */
  .staffrow.transposing {
    background: var(--pre-wash);
  }
  .staffrow.pointed {
    background: var(--accent-tint-strong);
  }
  /* The grab bar: a pill of dots under the staff's number, centred on the
     lines below the first (its row span is set per staff), with a press
     area of 24 by 40px around it. */
  .staffgrip {
    grid-column: 1;
    justify-self: center;
    align-self: center;
  }
  .staffrow.dragged {
    background: var(--accent-tint-strong);
    box-shadow: 0 2px 8px rgba(31, 36, 51, 0.14);
  }
  .staffrow.picked {
    background: var(--accent-tint-strong);
    outline: 1.5px solid var(--accent);
  }
  .staffline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .staffline > :global(.ctl),
  .staffline > :global(.gsel) {
    flex: 1 1 0;
    min-width: 0;
  }
  .staffline > :global(.gsel.clef) {
    flex: 0 1 96px;
  }
  .staffline > :global(.ctl.key) {
    flex: 0 0 68px;
  }
  .staffline.custom > :global(.ctl:first-child) {
    flex: 0 0 72px;
  }
  /* Docked (SetupForm's .setup.docked), the controls are 32px high and the
     text is larger: the transposition takes its own line below the clef and
     key. */
  :global(.setup.docked) .field select,
  :global(.setup.docked) .field input,
  :global(.setup.docked) .ctl {
    min-height: 32px;
  }
  :global(.setup.docked) .staffline + .staffline {
    flex-wrap: wrap;
  }
  :global(.setup.docked) .staffline > :global(.gsel.clef) {
    flex: 1 1 0;
  }
  :global(.setup.docked) .staffline > :global(.ctl.key) {
    flex: 1 1 0;
  }
  :global(.setup.docked) .staffline > :global(.ctl.trans) {
    order: 1;
    flex-basis: 100%;
  }
  .staffline > .ctl.lines {
    flex: 0 0 96px;
  }
  .staffno {
    flex: none;
    width: 22px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .addbtn {
    align-self: flex-start;
  }
  /* No element of the score setup carries .meterrow, .mfield, .field or
     .rowbtns; KeyTimeFields styles its own fields. */
  /* Key and time signature: two controls to a row, labelled like the
     group rows, set like the staff rows. */
  .meterrow {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .meterrow + .meterrow {
    margin-top: 8px;
  }
  .mfield {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .mfield > span {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field.narrow {
    flex: none;
    width: 88px;
  }
  .field span {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .field select,
  .field input {
    width: 100%;
  }
  .rowbtns {
    flex: none;
    display: flex;
    gap: 4px;
  }
</style>
