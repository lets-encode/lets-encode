<!--
  The submitted setup as text, for the reviewer and everyone not holding the
  task: what the rendering leaves open, the transposition, an octave clef,
  which label belongs to a staff or a group.
-->
<script lang="ts">
  import MusicGlyph from "$lib/components/MusicGlyph.svelte";
  import { staffKeysig } from "$lib/mei-facsimile.ts";
  import type { StaffGroupModel } from "$lib/mei-facsimile.ts";
  import type { GroupMarking } from "$lib/setup/group-marking.svelte.ts";
  import { METER_NAMES } from "$lib/setup/score-def.ts";
  import type { SetupModel } from "$lib/setup/setup-model.svelte.ts";
  import type { SetupPreview } from "$lib/setup/setup-preview.svelte.ts";
  import {
    groupText,
    symbolGlyph,
    symbolName,
    transText,
  } from "$lib/setup/setup-text.ts";
  import {
    KEY_SIGNATURES,
    clefGlyph,
    clefText,
    transposes,
    unpitched,
  } from "$lib/staff-edit.ts";
  import { groupDepth } from "$lib/staff-groups.ts";
  import { keysigText } from "$lib/transposition.ts";

  let {
    model,
    preview,
    marking,
    picking,
    onpickstaff,
    onpickgroup,
  }: {
    model: SetupModel;
    /** The pointed staff, coloured in the preview. */
    preview: SetupPreview;
    /** The hovered group, coloured in the preview. */
    marking: GroupMarking;
    /** Whether a click on a staff or group names it in a reviewer's change request. */
    picking: boolean;
    onpickstaff: (i: number) => void;
    onpickgroup: (g: StaffGroupModel) => void;
  } = $props();

  // The summary's columns for the groups beside the staves: one per level
  // of nesting.
  const groupColumns = $derived(
    model.groups.reduce(
      (n, g) => Math.max(n, groupDepth(model.groups, g) + 1),
      0,
    ),
  );
</script>

<div class="summary">
  <dl class="sumrest">
    <dt>Key signature</dt>
    <dd>
      {KEY_SIGNATURES.find((k) => k.value === model.keysig)?.label ??
        model.keysig}
    </dd>
    <dt>Time signature</dt>
    <dd>
      {#if model.meterType === "numeric"}
        {model.meterCount}/{model.meterUnit}
      {:else}
        <MusicGlyph name={model.meterType} />
        {METER_NAMES[model.meterType]}
      {/if}
    </dd>
  </dl>
  <section>
    <p class="grouphead">Staves</p>
    <!-- The groups drawn beside the staves they join, an outer group
       nearer the staves than the groups inside it. -->
    <div
      class="sumstaffs"
      style:grid-template-columns={`repeat(${groupColumns}, 12px) minmax(0, 1fr)`}
      style:grid-template-rows={`repeat(${model.staves.length}, auto)`}
    >
      {#each model.ordered as group (group)}
        <span
          class="summark"
          class:bracket={group.symbol !== "brace"}
          class:pointed={marking.hoveredGroup === group}
          style:grid-row={`${group.start} / ${group.end + 1}`}
          style:grid-column={groupColumns - groupDepth(model.groups, group)}
          aria-hidden="true"
          >{#if group.symbol === "brace"}<MusicGlyph
              name="brace"
              stretch
            />{/if}</span
        >
      {/each}
      <ol class="sumstaves">
        {#each model.staves as staff, i (i)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
          <li
            class:pointed={preview.pointedStaff === i}
            class:pickable={picking}
            onmouseenter={() => (preview.hoveredStaff = i)}
            onmouseleave={() => (preview.hoveredStaff = null)}
            onclick={() => onpickstaff(i)}
          >
            <span class="staffno">{i + 1}</span>
            <span class="sumbody">
              <span class="sumname" class:unnamed={!staff.label}
                >{staff.label || "No instrument name"}</span
              >
              <span class="summeta">
                <span class="clefname"
                  >{#if clefGlyph(staff)}<MusicGlyph
                      name={clefGlyph(staff)!}
                    />{/if}
                  {clefText(staff)}</span
                >
                {#if transposes(staff)}
                  <span>{transText(staff)}</span>
                {/if}
                {#if !unpitched(staff) && staffKeysig(model.keysig, staff) !== model.keysig}
                  <span
                    >Key: {keysigText(staffKeysig(model.keysig, staff))}</span
                  >
                {/if}
              </span>
            </span>
          </li>
        {/each}
      </ol>
    </div>
  </section>
  {#if model.groups.length}
    <section>
      <p class="grouphead">Groups</p>
      <ul class="sumgroups">
        {#each model.ordered as group (group)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
          <li
            class:inner={groupDepth(model.groups, group) > 0}
            class:pointed={marking.hoveredGroup === group}
            class:pickable={picking}
            onmouseenter={() => (marking.hoveredGroup = group)}
            onmouseleave={() => (marking.hoveredGroup = null)}
            onclick={() => onpickgroup(group)}
          >
            <span class="sumname"
              ><MusicGlyph name={symbolGlyph(group.symbol)} />
              {symbolName(group.symbol)}</span
            >
            <span class="summeta">{groupText(group)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .grouphead {
    margin: 0 0 10px;
    font-size: 13.5px;
    font-weight: 600;
  }
  .staffno {
    flex: none;
    width: 22px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ---------------------------------------------------------------- summary
     The submitted setup as text, for the reviewer and everyone not holding
     the task. */
  .summary {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* The staff rows, with a 12px column per level of groups before them;
     a group's mark spans its staves' rows. */
  .sumstaffs {
    display: grid;
    column-gap: 2px;
    row-gap: 6px;
  }
  .sumstaves {
    grid-column: -2;
    grid-row: 1 / -1;
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-rows: subgrid;
  }
  .summark {
    width: 8px;
    margin: 6px 0 6px 4px;
    color: var(--line-input);
  }
  .summark.bracket {
    width: 5px;
    margin-left: 5px;
    border: solid currentColor;
    border-width: 1.5px 0 1.5px 2px;
  }
  .summark.pointed {
    color: var(--accent);
  }
  .sumstaves > li {
    display: flex;
    gap: 6px;
    padding: 8px 8px 8px 4px;
    border-radius: 8px;
    background: var(--bg-tint);
  }
  .sumstaves > li.pointed {
    background: var(--accent-tint-strong);
  }
  .sumstaves .staffno {
    width: 16px;
    text-align: right;
  }
  .sumbody {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .sumname {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
  }
  .sumname.unnamed {
    font-weight: 400;
    color: var(--ink-faint);
  }
  .summeta {
    display: flex;
    flex-wrap: wrap;
    column-gap: 10px;
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .sumrest {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 12px;
    margin: 0;
    font-size: 12.5px;
  }
  .sumrest dt {
    font-weight: 600;
    color: var(--ink-faint);
  }
  .sumrest dd {
    margin: 0;
    color: var(--ink);
  }
  .sumgroups {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* While a change request is being written, a staff or group in the
     summary is clicked to name it in the request. */
  .sumstaves > li.pickable,
  .sumgroups > li.pickable {
    cursor: pointer;
  }
  .sumgroups > li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-radius: 8px;
    background: var(--bg-tint);
  }
  .sumgroups > li.inner {
    margin-left: 16px;
  }
  .sumgroups > li.pointed {
    background: var(--accent-tint-strong);
  }
</style>
