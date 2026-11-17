<!--
  The encoding alignment's panel: the staves of step 1 (AlignStaves) or, in
  step 2, the selected measure with the file measure it holds and the edits
  of the file's measures; below either, the problems worth a look.
-->
<script lang="ts">
  import type { AlignEditor } from "$lib/align/align-editor.svelte.ts";
  import { addFileMeasure, differentReason } from "$lib/encoding-align.ts";
  import Icon from "$lib/components/Icon.svelte";
  import MeasureSelection from "$lib/components/MeasureSelection.svelte";
  import Notice, { splitMessage } from "$lib/components/Notice.svelte";
  import type ScorePreview from "$lib/components/ScorePreview.svelte";
  import AlignStaves from "./AlignStaves.svelte";

  let {
    editor,
    canEdit,
    fixed,
    preview,
    oncomment,
    onshowproblem,
  }: {
    editor: AlignEditor;
    canEdit: boolean;
    /** The score's staves are fixed: no file staff may be left out. */
    fixed: boolean;
    /** The score viewer the measures are selected in. */
    preview:
      | Pick<
          ReturnType<typeof ScorePreview>,
          "pageOfMeasure" | "stepMeasure" | "canStepMeasure" | "clearSelection"
        >
      | undefined;
    /** Start a comment on the selected measure. */
    oncomment?: () => void;
    /** Show the layout measures a problem concerns. */
    onshowproblem: (measures: number[]) => void;
  } = $props();

  const aligned = $derived(editor.aligned!);
</script>

{#if editor.step === 1}
  <AlignStaves
    staves={aligned.scoreStaves}
    fileStaves={aligned.fileStaves}
    names={aligned.layoutStaffNames}
    automatic={editor.automatic}
    {fixed}
    {canEdit}
    chosen={editor.scoreStaves !== undefined}
    onchange={(list) => {
      editor.stepChoice = 1;
      editor.scoreStaves = list;
    }}
  />
{:else}
  <MeasureSelection
    label={editor.selectedMeasure}
    page={editor.selectedMeasure
      ? (preview?.pageOfMeasure(editor.selectedMeasure, editor.selectedAt) ??
        -1)
      : -1}
    {preview}
    {oncomment}
    empty="Select a measure on the score to see which file measure it holds."
  >
    {#if editor.selectedBox !== null}
      <p class="selflagtext">
        {!editor.selectedMatch
          ? "Holds no file measure"
          : editor.addedIds.has(aligned.file[editor.selectedMatch.measure].id)
            ? "Holds an added empty measure"
            : `Holds file measure ${editor.fileLabel(editor.selectedMatch)}`}
      </p>
    {/if}
    {#snippet actions()}
      {#if canEdit && editor.selectedBox !== null}
        <select
          class="ctl"
          value={editor.selectedMatch
            ? String(editor.selectedMatch.measure)
            : ""}
          onchange={(e) => {
            const v = e.currentTarget.value;
            editor.fix(v === "" ? null : { measure: Number(v), part: 0 });
          }}
          aria-label="File measure for this measure"
          title="Choose the file measure this measure holds, or none. The measures around it are placed again to fit."
        >
          <option value="">No file measure</option>
          {#each aligned.file as m, i (i)}
            <option value={String(i)}
              >{editor.addedIds.has(m.id)
                ? "Added empty measure"
                : `File measure ${editor.ownLabel(m.id, m.label)}`}{editor.held.has(
                i,
              )
                ? ""
                : " (no place)"}</option
            >
          {/each}
        </select>
        {#if editor.chosen}
          <button
            type="button"
            class="btn"
            onclick={editor.placeAutomatically}
            title="Let the alignment choose the file measure for this measure again"
            ><Icon name="wand" />Place automatically</button
          >
        {/if}
        {#if editor.selectedMatch}
          {@const m = editor.selectedMatch.measure}
          <button
            type="button"
            class="btn"
            onclick={() =>
              editor.editFile(
                addFileMeasure(
                  editor.fileEdits,
                  aligned.file.map((f) => f.id),
                  m,
                  "before",
                ),
              )}
            title="Insert an empty measure into the file before the file measure this measure holds"
            ><Icon name="plus" />Add file measure before</button
          >
          <button
            type="button"
            class="btn"
            onclick={() =>
              editor.editFile(
                addFileMeasure(
                  editor.fileEdits,
                  aligned.file.map((f) => f.id),
                  m,
                  "after",
                ),
              )}
            title="Insert an empty measure into the file after the file measure this measure holds"
            ><Icon name="plus" />Add file measure after</button
          >
          <button
            type="button"
            class="btn btn-danger"
            onclick={() => editor.removeFileMeasure(m)}
            title="Take the file measure this measure holds out of the file; the file measures after it move up"
            ><Icon name="trash" />Remove file measure</button
          >
        {/if}
      {/if}
    {/snippet}
  </MeasureSelection>
  {#if editor.fileChanges.length}
    <div class="filechanges">
      <p class="selgroup">Changes to the file's measures</p>
      <ul class="problems">
        {#each editor.fileChanges as change (change.key)}
          <li>
            <span class="ptext">{change.text}</span>
            {#if canEdit}
              <button
                type="button"
                class="btn btn-icon"
                onclick={change.undo}
                aria-label={change.added
                  ? "Remove this empty measure"
                  : "Put this file measure back"}
                title={change.added
                  ? "Remove this empty measure from the file"
                  : "Put this file measure back into the file"}
                ><Icon name={change.added ? "close" : "undo"} /></button
              >
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/if}
{#if aligned.summary.kind === "different"}
  <div class="different">
    <Notice
      tone="err"
      {...splitMessage(differentReason(aligned.summary))}
      live={false}
    />
  </div>
{:else if editor.problems.length}
  <ul class="problems">
    {#each editor.problems as problem, i (i)}
      <li>
        <Icon name="warning" size={14} />
        <span class="ptext" title={problem.title}>{problem.text}</span>
        {#if problem.measures.length}
          <button
            type="button"
            class="btn"
            onclick={() => onshowproblem(problem.measures)}>Show</button
          >
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .different {
    margin-top: 10px;
  }
  .problems {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  /* The changes to the file's measures, under their group name. */
  .filechanges {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .filechanges .problems {
    margin: 0;
  }
  .problems li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* The problem's text, its Show button at the line's right end. */
  .ptext {
    flex: 1;
    min-width: 0;
  }
  .problems > li > :global(svg) {
    flex: none;
    color: var(--warn-solid);
  }
</style>
