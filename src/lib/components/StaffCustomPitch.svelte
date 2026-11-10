<!--
  The pitch fields of a staff whose transposition is "Other…" (outside the
  list): the pitch the instrument is in, whether it sounds higher or lower,
  and whole octaves added.
-->
<script lang="ts">
  import type { StaffModel } from "$lib/mei-facsimile.ts";
  import type { StaffPitchEditor } from "$lib/staff-pitch.svelte.ts";
  import { PITCHES } from "$lib/transposition.ts";

  let {
    editor,
    staff,
    name,
  }: {
    editor: StaffPitchEditor;
    staff: StaffModel;
    /** The staff's name for the controls' accessible names. */
    name: string;
  } = $props();

  const c = $derived(editor.customOf(staff));
</script>

<select
  class="ctl"
  value={c.pitch}
  onchange={(e) =>
    editor.setCustom(staff, { pitch: (e.target as HTMLSelectElement).value })}
  aria-label={`${name}: instrument pitch`}
  title="The pitch the instrument is in: the note that sounds when a C is written."
>
  {#each PITCHES as p (p.name)}
    <option value={p.name}>in {p.name}</option>
  {/each}
</select>
<select
  class="ctl"
  value={c.higher ? "higher" : "lower"}
  onchange={(e) =>
    editor.setCustom(staff, {
      higher: (e.target as HTMLSelectElement).value === "higher",
    })}
  aria-label={`${name}: sounds higher or lower`}
  title="Whether the instrument sounds higher or lower than written."
>
  <option value="lower">sounds lower</option>
  <option value="higher">sounds higher</option>
</select>
<select
  class="ctl"
  value={String(c.octaves)}
  onchange={(e) =>
    editor.setCustom(staff, {
      octaves: Number((e.target as HTMLSelectElement).value),
    })}
  aria-label={`${name}: added octaves`}
  title="Whole octaves added to the interval, as for a bass clarinet."
>
  <option value="0">no octave</option>
  <option value="1">+1 octave</option>
  <option value="2">+2 octaves</option>
</select>
