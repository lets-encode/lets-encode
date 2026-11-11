<!--
  The score setup form in the side panel: in step 1 the key and time
  signature and the staves, in step 2 the groups. Docked below the score as
  a sheet, the steps head the form.
-->
<script lang="ts">
  import KeyTimeFields from "$lib/components/KeyTimeFields.svelte";
  import type { GroupMarking } from "$lib/setup/group-marking.svelte.ts";
  import type { SetupModel } from "$lib/setup/setup-model.svelte.ts";
  import type { SetupPreview } from "$lib/setup/setup-preview.svelte.ts";
  import type { StaffListEditor } from "$lib/setup/staff-list.svelte.ts";
  import GroupsStep from "./GroupsStep.svelte";
  import SetupSteps from "./SetupSteps.svelte";
  import StaffList from "./StaffList.svelte";

  let {
    model,
    staffList,
    marking,
    preview,
    canEdit,
    hasNotation,
    docked,
    step,
    ongo,
    markable,
    compact,
    tapWord,
  }: {
    model: SetupModel;
    staffList: StaffListEditor;
    marking: GroupMarking;
    preview: SetupPreview;
    canEdit: boolean;
    /** Whether the piece holds notation, which fixes the staff count. */
    hasNotation: boolean | undefined;
    /** Whether the panel is docked below the score as a sheet. */
    docked: boolean;
    step: 1 | 2;
    ongo: (step: 1 | 2) => void;
    /** Whether groups are being marked in the preview. */
    markable: boolean;
    /** Whether the docked sheet is closed. */
    compact: boolean;
    /** "Tap" on a touch screen, else "Click". */
    tapWord: string;
  } = $props();
</script>

<form class="setup" class:docked onsubmit={(e) => e.preventDefault()}>
  {#if docked}<SetupSteps
      {step}
      staves={model.staves.length}
      groups={model.groups.length}
      {ongo}
    />{/if}
  {#if step === 1}
    <fieldset disabled={!canEdit} class="sec-meter">
      <p class="grouphead">Key and time signature</p>
      <KeyTimeFields
        bind:keysig={model.keysig}
        bind:meterType={model.meterType}
        bind:meterCount={model.meterCount}
        bind:meterUnit={model.meterUnit}
        meterValid={model.meterValid}
      />
    </fieldset>

    <fieldset disabled={!canEdit} class="sec-staves">
      <p class="grouphead">Staves</p>
      <StaffList {model} editor={staffList} {preview} {canEdit} {hasNotation} />
    </fieldset>
  {:else}
    <fieldset disabled={!canEdit} class="sec-groups">
      <p class="grouphead">Groups</p>
      <GroupsStep {model} {marking} {canEdit} {markable} {compact} {tapWord} />
    </fieldset>
  {/if}
</form>

<style>
  /* ------------------------------------------------------------------- form */
  /* The form in the side panel: the step's sections. */
  .setup {
    display: flex;
    flex-direction: column;
    gap: 12px;
    container-type: inline-size;
  }
  /* Docked, the 32px buttons take a 44px press through an invisible
     ::after. */
  .setup.docked :global(.gsel) {
    min-height: 32px;
  }
  .setup.docked :global(.btn) {
    position: relative;
  }
  .setup.docked :global(.btn)::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
  /* The step's sections share the panel's paper, a hairline between them
     running to its edges. */
  .setup fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .setup fieldset + fieldset {
    margin-inline: -16px;
    padding: 14px 16px 0;
    border-top: 1px solid var(--line);
  }
  .grouphead {
    margin: 0 0 10px;
    font-size: 13.5px;
    font-weight: 600;
  }
  /* The staff blocks take the section's width up to a narrow margin. */
  .setup fieldset.sec-staves {
    padding-inline: 8px;
  }
  /* The glyph select takes the look of the shared compact control (.ctl). */
  .setup :global(.gsel) {
    font: inherit;
    font-size: 13px;
    box-sizing: border-box;
    height: 32px;
    padding: 4px 8px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
    text-overflow: ellipsis;
  }
  .setup :global(.gsel:disabled) {
    color: var(--ink-faint);
    background: var(--bg-tint);
    cursor: not-allowed;
  }
</style>
