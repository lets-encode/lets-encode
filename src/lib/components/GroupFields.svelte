<!--
  The fields of a group of staves or instruments: its symbol (brace or
  bracket), its first and last member, a remove button, its label, whether
  the barlines run through it and, for a brace given `ononeinstrument`,
  whether its staves are one instrument. The score setup edits staff groups
  with it, the instruments step instrument groups.
-->
<script lang="ts" generics="T extends string | number">
  import GlyphSelect from "./GlyphSelect.svelte";
  import Icon from "./Icon.svelte";

  type Option = { value: T; label: string; disabled?: boolean };
  let {
    unit,
    from,
    to,
    fromOptions,
    toOptions,
    onfrom,
    onto,
    symbol,
    onsymbol,
    braceDisabled = false,
    label,
    onlabel,
    onlabelinput,
    barThru,
    onbarthru,
    oneInstrument = false,
    ononeinstrument,
    disabled = false,
    onremove,
    removeLabel,
  }: {
    /** What the group's members are, for the field names. */
    unit: "staff" | "instrument";
    from: T;
    to: T;
    fromOptions: Option[];
    toOptions: Option[];
    onfrom: (value: T) => void;
    onto: (value: T) => void;
    /** MEI staffGrp @symbol: 'brace' or 'bracket'. */
    symbol: string;
    onsymbol: (symbol: string) => void;
    braceDisabled?: boolean;
    label: string;
    /** The label as committed (on change). */
    onlabel?: (label: string) => void;
    /** The label as typed. */
    onlabelinput?: (label: string) => void;
    barThru: boolean;
    onbarthru: (barThru: boolean) => void;
    oneInstrument?: boolean;
    ononeinstrument?: (oneInstrument: boolean) => void;
    disabled?: boolean;
    onremove?: () => void;
    /** The remove button's accessible name. */
    removeLabel?: string;
  } = $props();

  const id = $props.id();
  const member = $derived(unit === "staff" ? "staff" : "instrument");
</script>

<div class="gfields">
  <div class="gfirst">
    <div class="field">
      <span>Symbol</span>
      <GlyphSelect
        options={[
          {
            value: "brace",
            label: "Brace",
            glyph: "brace",
            disabled: disabled || braceDisabled,
          },
          {
            value: "bracket",
            label: "Bracket",
            glyph: "bracket",
            disabled,
          },
        ]}
        value={symbol === "brace" ? "brace" : "bracket"}
        onchange={onsymbol}
        label="Symbol"
        title="A brace joins the staves of one instrument, like a piano, or of a pair, like Horn 1 and 2. A bracket joins a section, like the strings."
      />
    </div>
    <label class="field" class:narrow={unit === "staff"}>
      <span>From {member}</span>
      <select
        class="ctl"
        value={from}
        {disabled}
        title={`The group's first ${member}.`}
        onchange={(e) =>
          onfrom(
            fromOptions[(e.target as HTMLSelectElement).selectedIndex].value,
          )}
      >
        {#each fromOptions as o (o.value)}
          <option value={o.value} disabled={o.disabled}>{o.label}</option>
        {/each}
      </select>
    </label>
    <label class="field" class:narrow={unit === "staff"}>
      <span>To {member}</span>
      <select
        class="ctl"
        value={to}
        {disabled}
        title={`The group's last ${member}.`}
        onchange={(e) =>
          onto(toOptions[(e.target as HTMLSelectElement).selectedIndex].value)}
      >
        {#each toOptions as o (o.value)}
          <option value={o.value} disabled={o.disabled}>{o.label}</option>
        {/each}
      </select>
    </label>
    {#if onremove && !disabled}
      <button
        type="button"
        class="btn btn-icon btn-danger"
        onclick={onremove}
        aria-label={removeLabel ?? "Remove this group"}
        title="Remove this group"><Icon name="trash" /></button
      >
    {/if}
  </div>
  <label class="field">
    <span>Label</span>
    <input
      class="ctl"
      type="text"
      value={label}
      {disabled}
      placeholder={disabled ? "—" : "optional"}
      title="The name printed in front of the group, like Piano or Violini. Leave empty for none."
      oninput={(e) => onlabelinput?.((e.target as HTMLInputElement).value)}
      onchange={(e) => onlabel?.((e.target as HTMLInputElement).value)}
    />
  </label>
  <div class="gtoggles">
    <div class="mfield">
      <span id="{id}-bar">Barlines</span>
      <div
        class="seg gseg"
        role="group"
        aria-labelledby="{id}-bar"
        title="Whether the barlines run through the group's staves or stop at each staff, as on the page."
      >
        <button
          type="button"
          class:on={barThru}
          aria-pressed={barThru}
          {disabled}
          onclick={() => onbarthru(true)}>Through</button
        >
        <button
          type="button"
          class:on={!barThru}
          aria-pressed={!barThru}
          {disabled}
          onclick={() => onbarthru(false)}>Per staff</button
        >
      </div>
    </div>
    {#if symbol === "brace" && ononeinstrument}
      <div class="mfield">
        <span id="{id}-instr">Staves</span>
        <div
          class="seg gseg"
          role="group"
          aria-labelledby="{id}-instr"
          title="One instrument: one player's part over several staves, like a piano or a harp. Separate staves: one instrument per staff, like Horn 1 and 2. Set from the labels until chosen here."
        >
          <button
            type="button"
            class:on={oneInstrument}
            aria-pressed={oneInstrument}
            {disabled}
            onclick={() => ononeinstrument(true)}>One instrument</button
          >
          <button
            type="button"
            class:on={!oneInstrument}
            aria-pressed={!oneInstrument}
            {disabled}
            onclick={() => ononeinstrument(false)}>Separate staves</button
          >
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .gfields {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .gfirst {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .gfirst > .field.narrow {
    flex: none;
    width: 72px;
  }
  .field > span,
  .mfield > span {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .field select,
  .field input {
    width: 100%;
  }
  .gtoggles {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .mfield {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .gseg {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
  }
  .gseg > button {
    justify-content: center;
  }
</style>
