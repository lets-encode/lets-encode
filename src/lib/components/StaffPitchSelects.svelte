<!--
  A staff's transposition and key signature, as the score setup and the score
  check edit them: the transposition from a list (or "Other…", whose pitch
  fields StaffCustomPitch shows), and the key, which follows the score's
  unless one is chosen for the staff alone.
-->
<script lang="ts">
  import type { StaffModel } from "$lib/mei-facsimile.ts";
  import type { StaffPitchEditor } from "$lib/staff-pitch.svelte.ts";
  import {
    KEY_SIGNATURES,
    followedKey,
    settleKey,
    transOf,
    transposes,
  } from "$lib/staff-edit.ts";
  import {
    COMMON_TRANSPOSITIONS,
    keysigText,
    soundsText,
  } from "$lib/transposition.ts";

  let {
    editor,
    staff,
    scoreKey,
    name,
  }: {
    editor: StaffPitchEditor;
    staff: StaffModel;
    /** The score's key signature. */
    scoreKey: string;
    /** The staff's name for the controls' accessible names. */
    name: string;
  } = $props();
</script>

<select
  class="ctl trans"
  value={editor.value(staff)}
  onchange={(e) => editor.pick(staff, (e.target as HTMLSelectElement).value)}
  aria-label={`${name}: transposition`}
  title={transposes(staff)
    ? `Sounds ${soundsText(transOf(staff))} than written.`
    : "Whether the instrument transposes: its music is written at another pitch than it sounds."}
>
  <option value="none">Not transposing</option>
  {#each COMMON_TRANSPOSITIONS as t, n (n)}
    <option value={String(n)}>{t.label}</option>
  {/each}
  <option value="other">Other…</option>
</select>
<select
  class="ctl key"
  value={staff.keysig ?? ""}
  onchange={(e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "") delete staff.keysig;
    else staff.keysig = v;
    settleKey(scoreKey, staff);
  }}
  aria-label={`${name}: key signature`}
  title={staff.keysig === undefined
    ? transposes(staff)
      ? "The key signature of this staff: the score's, moved by the transposition."
      : "The key signature of this staff: the score's."
    : "The key signature of this staff, chosen for it alone."}
>
  <optgroup label={transposes(staff) ? "Score key, transposed" : "Score key"}>
    <option value="">{keysigText(followedKey(scoreKey, staff))}</option>
  </optgroup>
  <optgroup label="This staff only">
    {#each KEY_SIGNATURES as k (k.value)}
      <option value={k.value}>{k.label}</option>
    {/each}
  </optgroup>
</select>
