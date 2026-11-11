<!--
  The selected measure's properties in the side panel: its breaks, repeats,
  ending and signs as toggles; read-only, the ones that apply as one line.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { MEASURE_SIGNS } from "$lib/mei-facsimile.ts";
  import {
    markNames,
    pbAt,
    sbActive,
    sectionLocked,
    SIGN_NAME,
    SIGN_TITLE,
    startsMovement,
  } from "$lib/zones/measures.ts";
  import type { ZonePages } from "$lib/zones/zone-pages.svelte.ts";

  let {
    model,
    p,
    z,
    canEdit,
  }: {
    model: ZonePages;
    /** The measure's page. */
    p: number;
    /** The measure's index on its page. */
    z: number;
    canEdit: boolean;
  } = $props();

  const pages = $derived(model.pages);
</script>

{#if canEdit}
  <div class="selprops">
    <p class="selgroup">Breaks</p>
    <div class="selflags" role="group" aria-label="Breaks">
      <button
        type="button"
        class="chip-switch"
        class:on={sbActive(pages, p, z)}
        aria-pressed={sbActive(pages, p, z)}
        onclick={() => model.toggleSb(p, z)}
        disabled={pbAt(z)}
        title={pbAt(z)
          ? "The first measure on a page always starts a system"
          : "This measure starts a new system (line) of the score"}
        ><span class="sellong">Starts a system</span><span class="selshort"
          >System</span
        ></button
      >
      <button
        type="button"
        class="chip-switch"
        class:on={startsMovement(pages, p, z)}
        aria-pressed={startsMovement(pages, p, z)}
        onclick={() => model.toggleSection(p, z)}
        disabled={sectionLocked(p, z)}
        title={sectionLocked(p, z)
          ? "The first measure always starts the first section"
          : "This measure starts a new movement or section"}
        ><span class="sellong">Starts a section</span><span class="selshort"
          >Section</span
        ></button
      >
      <button
        type="button"
        class="chip-switch"
        class:on={pages[p].zones[z].pickup}
        aria-pressed={pages[p].zones[z].pickup}
        onclick={() => model.togglePickup(p, z)}
        title="An incomplete measure that is not counted: numbered 0 at the start of a section, otherwise it and the measure before it are numbered as halves, e.g. 12a and 12b"
        >Pickup</button
      >
    </div>
    <p class="selgroup">Repeats</p>
    <div class="selflags" role="group" aria-label="Repeats">
      <button
        type="button"
        class="chip-switch"
        class:on={!!pages[p].zones[z].rptStart}
        aria-pressed={!!pages[p].zones[z].rptStart}
        onclick={() => model.toggleRepeat(p, z, "start")}
        aria-label="Repeat start"
        title="A repeat barline at the start of this measure"
        ><Icon name="repeat-start" /><span class="sellong">Repeat start</span
        ></button
      >
      <button
        type="button"
        class="chip-switch"
        class:on={!!pages[p].zones[z].rptEnd}
        aria-pressed={!!pages[p].zones[z].rptEnd}
        onclick={() => model.toggleRepeat(p, z, "end")}
        aria-label="Repeat end"
        title="A repeat barline at the end of this measure"
        ><Icon name="repeat-end" /><span class="sellong">Repeat end</span
        ></button
      >
      <button
        type="button"
        class="chip-switch"
        class:on={!!pages[p].zones[z].rptBoth}
        aria-pressed={!!pages[p].zones[z].rptBoth}
        onclick={() => model.toggleRepeat(p, z, "both")}
        title="A double repeat barline at the end of this measure: the end of one repeat and the start of the next"
        aria-label="Double repeat"
        ><Icon name="repeat-both" /><span class="sellong">Double repeat</span
        ></button
      >
      <div
        class="seg"
        role="group"
        aria-label="Ending"
        title="The ending (volta) this measure belongs to; neighbouring measures with the same ending share one bracket"
      >
        {#each ["", "1", "2", "3"] as n (n)}
          <button
            type="button"
            class:on={(pages[p].zones[z].ending ?? "") === n}
            aria-pressed={(pages[p].zones[z].ending ?? "") === n}
            onclick={() => model.setEnding(p, z, n)}
            >{#if n}{n}.{:else}<span class="sellong">No ending</span><span
                class="selshort">No</span
              >{/if}</button
          >
        {/each}
      </div>
    </div>
    <p class="selgroup">Signs</p>
    <div class="selflags" role="group" aria-label="Signs">
      {#each MEASURE_SIGNS as sign (sign)}
        <button
          type="button"
          class="chip-switch"
          class:on={!!pages[p].zones[z].signs?.includes(sign)}
          aria-pressed={!!pages[p].zones[z].signs?.includes(sign)}
          onclick={() => model.toggleSign(p, z, sign)}
          aria-label={SIGN_NAME[sign]}
          title={SIGN_TITLE[sign]}
          >{#if sign === "segno" || sign === "coda"}<Icon name={sign} /><span
              class="sellong">{SIGN_NAME[sign]}</span
            >{:else}{SIGN_NAME[sign]}{/if}</button
        >
      {/each}
    </div>
  </div>
{:else}
  <!-- Read-only, the toggles give way to the breaks that apply. -->
  {@const flags = [
    sbActive(pages, p, z) ? "Starts a system" : "",
    startsMovement(pages, p, z) ? "Starts a section" : "",
    pages[p].zones[z].pickup ? "Pickup" : "",
    ...markNames(pages[p].zones[z]),
  ].filter(Boolean)}
  {#if flags.length}
    <p class="selflagtext">{flags.join(" · ")}</p>
  {/if}
{/if}
