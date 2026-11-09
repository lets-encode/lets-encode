<!--
  The score's key signature and time signature, as the score setup and the
  score check edit them: the key, the time signature as numbers or a symbol,
  and for numbers the beats and the beat unit.
-->
<script lang="ts">
  import GlyphSelect from "$lib/components/GlyphSelect.svelte";
  import { KEY_SIGNATURES } from "$lib/staff-edit.ts";

  const METER_KINDS = [
    { value: "numeric", label: "Numbers", glyph: "threeFour" },
    { value: "common", label: "Common time", glyph: "common" },
    { value: "cut", label: "Cut time", glyph: "cut" },
  ] as const;
  const METER_UNITS = [1, 2, 4, 8, 16];

  let {
    keysig = $bindable(),
    meterType = $bindable(),
    meterCount = $bindable(),
    meterUnit = $bindable(),
    meterValid,
    onkeychange,
  }: {
    keysig: string;
    meterType: "numeric" | "common" | "cut";
    meterCount: string;
    meterUnit: string;
    /** The beats entered are a number a time signature can have. */
    meterValid: boolean;
    /** Called after the key signature changed. */
    onkeychange?: () => void;
  } = $props();
</script>

<div class="meterrow">
  <label class="mfield">
    <span>Key signature</span>
    <select
      class="ctl"
      bind:value={keysig}
      onchange={() => onkeychange?.()}
      title="The accidentals the score opens with, on the staves that do not transpose."
    >
      {#each KEY_SIGNATURES as key (key.value)}
        <option value={key.value}>{key.label}</option>
      {/each}
    </select>
  </label>
  <div class="mfield">
    <span>Time signature</span>
    <GlyphSelect
      class="ctl"
      options={METER_KINDS}
      value={meterType}
      onchange={(v) => (meterType = v as typeof meterType)}
      label="Time signature"
      title="Numbers (beats over a beat unit), or a symbol: common time or cut time."
    />
  </div>
</div>
{#if meterType === "numeric"}
  <div class="meterrow">
    <label class="mfield">
      <span>Beats</span>
      <input
        class="ctl"
        type="text"
        inputmode="numeric"
        bind:value={meterCount}
        class:bad={!meterValid}
        title="The number of beats in a bar — the upper number of the time signature."
      />
    </label>
    <label class="mfield">
      <span>Beat unit</span>
      <select
        class="ctl"
        bind:value={meterUnit}
        title="The note value that counts as one beat — the lower number of the time signature."
      >
        {#each METER_UNITS as unit (unit)}
          <option value={String(unit)}>{unit}</option>
        {/each}
      </select>
    </label>
  </div>
{/if}

<style>
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
  .mfield > .ctl.bad {
    border-color: var(--danger-line);
  }
</style>
