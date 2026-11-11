<!--
  The score setup's groups, step 2: the marking in the preview (the first
  staff, the last, the symbol), then the groups, one line each in staff
  order, the open one showing its values, and "Add group". Docked and
  closed, the sheet shows the marking line or the open group alone.
-->
<script lang="ts">
  import GroupFields from "$lib/components/GroupFields.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import MusicGlyph from "$lib/components/MusicGlyph.svelte";
  import type { StaffGroupModel } from "$lib/mei-facsimile.ts";
  import type { GroupMarking } from "$lib/setup/group-marking.svelte.ts";
  import type { SetupModel } from "$lib/setup/setup-model.svelte.ts";
  import { symbolGlyph, symbolName } from "$lib/setup/setup-text.ts";
  import { groupDepth } from "$lib/staff-groups.ts";

  let {
    model,
    marking,
    canEdit,
    markable,
    compact,
    tapWord,
  }: {
    model: SetupModel;
    marking: GroupMarking;
    canEdit: boolean;
    /** Whether groups are being marked in the preview. */
    markable: boolean;
    /** Whether the docked sheet is closed. */
    compact: boolean;
    /** "Tap" on a touch screen, else "Click". */
    tapWord: string;
  } = $props();
</script>

<p class="vh" aria-live="polite">{marking.liveText}</p>
<!-- The marking in the preview: the first staff, the last, the
     symbol. Docked and closed, the sheet shows this line or the
     open group. -->
{#if markable && !(compact && marking.openG && marking.markFrom === null)}
  <div class="markline">
    {#if marking.markFrom === null}
      <p class="markhint">
        {tapWord} the first staff of a group in the preview.
      </p>
    {:else if marking.markTo === null}
      <p class="markhint">
        <strong>Staff {marking.markFrom + 1}</strong> · {tapWord.toLowerCase()}
        the last staff of the group.
      </p>
      <div class="markbtns">
        {#each marking.containing(marking.markFrom + 1) as g (g)}
          <button
            type="button"
            class="btn"
            onclick={() => marking.toggleRow(g)}
            title="Open this group"
            ><MusicGlyph name={symbolGlyph(g.symbol)} />{symbolName(g.symbol)}
            {g.start}–{g.end}</button
          >
        {/each}
        <button type="button" class="btn" onclick={() => marking.clearMark()}
          >Cancel</button
        >
      </div>
    {:else if marking.markSpan}
      <p class="markhint">
        <strong>Staves {marking.markSpan.start}–{marking.markSpan.end}</strong>
      </p>
      {#if marking.markProblem}
        <p class="groupwarn">{marking.markProblem}</p>
      {/if}
      <div class="markbtns">
        {#if marking.sameGroup}
          {@const sameGroup = marking.sameGroup}
          <button
            type="button"
            class="btn"
            onclick={() => marking.toggleRow(sameGroup)}
            title="Open this group"
            ><MusicGlyph name={symbolGlyph(sameGroup.symbol)} />{symbolName(
              sameGroup.symbol,
            )}
            {sameGroup.start}–{sameGroup.end}</button
          >
        {:else if !marking.markProblem}
          <button
            type="button"
            class="btn"
            onclick={() => marking.addMarked("brace")}
            title="Join the staves with a brace: the staves of one instrument, like a piano, or of a pair, like Horn 1 and 2."
            ><MusicGlyph name="brace" />Brace</button
          >
          <button
            type="button"
            class="btn"
            onclick={() => marking.addMarked("bracket")}
            title="Join the staves with a bracket: a section, like the woodwinds or the strings."
            ><MusicGlyph name="bracket" />Bracket</button
          >
        {/if}
        <button type="button" class="btn" onclick={() => marking.clearMark()}
          >Cancel</button
        >
      </div>
    {/if}
  </div>
{/if}
{#if compact}
  {#if marking.openG && marking.markFrom === null}{@render groupRow(
      marking.openG,
    )}{/if}
{:else}
  <ul class="glist">
    {#each model.ordered as g (g)}
      <li>{@render groupRow(g)}</li>
    {:else}
      <li class="muted">No groups.</li>
    {/each}
  </ul>
  {#if canEdit && marking.freePair !== null}
    <button
      type="button"
      class="btn addbtn"
      onclick={() => marking.addGroup()}
      title="Join two neighbouring staves with a brace. Its staves and symbol can be changed below."
      ><Icon name="plus" />Add group</button
    >
  {/if}
{/if}
{#if !model.groupsValid}
  <p class="groupwarn">
    Groups must fit the staves and must contain whole groups.
  </p>
{/if}

<!-- A group: its line (symbol, staves, label), opening its values. -->
{#snippet groupRow(g: StaffGroupModel)}
  <div
    class="gitem"
    class:open={marking.openG === g}
    class:inner={groupDepth(model.groups, g) > 0}
    role="group"
    aria-label={`${symbolName(g.symbol)}, staves ${g.start} to ${g.end}`}
    onmouseenter={() => (marking.hoveredGroup = g)}
    onmouseleave={() => (marking.hoveredGroup = null)}
  >
    <button
      type="button"
      class="gline"
      aria-expanded={marking.openG === g}
      onclick={() => marking.toggleRow(g)}
      title={marking.openG === g ? "Close this group" : "Open this group"}
    >
      <span class="gsym"
        ><MusicGlyph name={symbolGlyph(g.symbol)} />
        {symbolName(g.symbol)}</span
      >
      <span class="gstaves">{g.start}–{g.end}</span>
      <span class="glabel">{g.label.trim()}</span>
    </button>
    {#if marking.openG === g}
      <div class="gbody">
        <GroupFields
          unit="staff"
          from={g.start}
          to={g.end}
          fromOptions={model.staves.map((_, n) => ({
            value: n + 1,
            label: `${n + 1}`,
            disabled: !model.fitsWith(g, { start: n + 1 }),
          }))}
          toOptions={model.staves.map((_, n) => ({
            value: n + 1,
            label: `${n + 1}`,
            disabled: !model.fitsWith(g, { end: n + 1 }),
          }))}
          onfrom={(v) => (g.start = v)}
          onto={(v) => (g.end = v)}
          symbol={g.symbol}
          onsymbol={(v) => (g.symbol = v)}
          braceDisabled={!model.fitsWith(g, { symbol: "brace" })}
          label={g.label}
          onlabelinput={(v) => (g.label = v)}
          barThru={g.barThru}
          onbarthru={(v) => (g.barThru = v)}
          oneInstrument={g.oneInstrument}
          ononeinstrument={(v) => model.setOneInstrument(g, v)}
          disabled={!canEdit}
          onremove={() => marking.removeGroup(g)}
          removeLabel={`Remove the ${symbolName(g.symbol).toLowerCase()} over staves ${g.start}–${g.end}`}
        />
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }
  /* The marking in the preview: what to do next, then its buttons. */
  .markline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }
  .markhint {
    margin: 0;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .markhint strong {
    font-weight: 600;
    color: var(--ink);
  }
  .markbtns {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .markline > .groupwarn {
    margin: 0;
  }
  /* The groups, one line each in staff order, an inner group indented
     under the group holding it; the open one shows its values below. */
  .glist {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .gitem {
    border-radius: 8px;
    background: var(--bg-tint);
  }
  .gitem.inner {
    margin-left: 16px;
  }
  .gitem.open {
    background: var(--accent-tint-strong);
  }
  .gline {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    min-height: 32px;
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
    text-align: left;
    color: var(--ink);
    background: none;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  .gline:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .gsym {
    font-weight: 600;
  }
  .gstaves {
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .glabel {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-soft);
  }
  .gbody {
    padding: 2px 10px 10px;
  }
  .groupwarn {
    margin: 8px 0 0;
    font-size: 12.5px;
    color: var(--danger);
  }
  .addbtn {
    align-self: flex-start;
  }
</style>
