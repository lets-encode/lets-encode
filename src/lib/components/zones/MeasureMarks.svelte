<!--
  A measure box's marks on the page, in its SVG: the label with the measure
  number, a system start's bracket, a section start's double bar and a repeat
  start's sign before it; a repeat end or double repeat in a label at the
  box's top right; the navigation signs as tags along its bottom edge. The
  label repeats the box's name for the eye.
-->
<svelte:options namespace="svg" />

<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { SIGN_TEXT } from "$lib/mei-facsimile.ts";
  import type { EditZone } from "$lib/zones/edit-pages.ts";

  let {
    zone,
    fs,
    system,
    section,
    on,
  }: {
    zone: EditZone;
    /** The label's font size in page pixels. */
    fs: number;
    /** The measure starts a system. */
    system: boolean;
    /** The measure starts a section. */
    section: boolean;
    /** The measure is selected. */
    on: boolean;
  } = $props();

  const lbl = $derived(zone.label);
  const inset = $derived(fs * 0.6);
  // Before the number: a system start's bracket, a section start's double
  // bar, a repeat start's sign.
  const sy = $derived(system ? fs * 0.6 : 0);
  const bar = $derived(section ? fs * 0.7 : 0);
  const rs = $derived(zone.rptStart ? fs * 1.15 : 0);
  const pre = $derived(sy + bar + rs);
  const lblW = $derived(lbl.length * fs * 0.62 + fs * 0.9 + pre);
  const b = $derived(zone.box);
</script>

<rect
  aria-hidden="true"
  class="labelbg"
  class:on
  x={zone.box.ulx + inset}
  y={zone.box.uly + inset}
  width={lblW}
  height={fs * 1.55}
  rx={fs * 0.28}
/>
{#if sy}
  {@const sx = zone.box.ulx + inset + fs * 0.45}
  {@const sy0 = zone.box.uly + inset + fs * 0.3}
  <path
    aria-hidden="true"
    class="sysmark"
    class:on
    vector-effect="non-scaling-stroke"
    d={`M${sx + fs * 0.3} ${sy0}h${-fs * 0.3}v${fs * 0.95}h${fs * 0.3}`}
  />
{/if}
{#if bar}
  {@const bx = zone.box.ulx + inset + sy + fs * 0.45}
  {@const by = zone.box.uly + inset + fs * 0.3}
  <rect
    aria-hidden="true"
    class="dbar"
    class:on
    x={bx}
    y={by}
    width={fs * 0.1}
    height={fs * 0.95}
  />
  <rect
    aria-hidden="true"
    class="dbar"
    class:on
    x={bx + fs * 0.24}
    y={by}
    width={fs * 0.22}
    height={fs * 0.95}
  />
{/if}
<text
  aria-hidden="true"
  class="zonelabel"
  class:on
  x={zone.box.ulx + inset + pre + (lblW - pre) / 2}
  y={zone.box.uly + inset + fs * 1.12}
  text-anchor="middle"
  font-size={fs}>{lbl}</text
>
<!-- Repeat signs as icons on the label's paper: a
     start in the number's label, an end or a double
     repeat in a label at the box's top right, at
     the barline it stands on. -->
{#if rs}
  <g
    aria-hidden="true"
    class="repicon"
    class:on
    transform={`translate(${b.ulx + inset + sy + bar + fs * 0.4} ${b.uly + inset + fs * 0.27}) scale(${fs / 24})`}
  >
    <Icon name="repeat-start" size={24} />
  </g>
{/if}
{#if zone.rptEnd || zone.rptBoth}
  {@const rw = fs * 1.7}
  {@const rx = b.lrx - inset - rw}
  <rect
    aria-hidden="true"
    class="labelbg"
    class:on
    x={rx}
    y={b.uly + inset}
    width={rw}
    height={fs * 1.55}
    rx={fs * 0.28}
  />
  <g
    aria-hidden="true"
    class="repicon"
    class:on
    transform={`translate(${rx + rw / 2 - fs * 0.5} ${b.uly + inset + fs * 0.27}) scale(${fs / 24})`}
  >
    <Icon name={zone.rptBoth ? "repeat-both" : "repeat-end"} size={24} />
  </g>
{/if}
<!-- The signs, as tags along the box's bottom
     edge from the right: a symbol or its text. -->
{#if zone.signs?.length}
  {@const tagH = fs * 1.55}
  {@const tagY = b.lry - inset - tagH}
  {#each zone.signs
    .map( (sign) => ({ sign, w: SIGN_TEXT[sign] ? SIGN_TEXT[sign].length * fs * 0.58 + fs * 0.9 : tagH * 1.2 }), )
    .map((t, i, all) => ({ ...t, x: b.lrx - inset - all
          .slice(i)
          .reduce((sum, u) => sum + u.w + fs * 0.25, 0) + fs * 0.25 })) as t (t.sign)}
    <g aria-hidden="true" class="signtag">
      <rect x={t.x} y={tagY} width={t.w} height={tagH} rx={tagH / 2} />
      {#if SIGN_TEXT[t.sign]}
        <text
          x={t.x + t.w / 2}
          y={tagY + tagH * 0.7}
          text-anchor="middle"
          font-size={fs * 0.9}>{SIGN_TEXT[t.sign]}</text
        >
      {:else}
        <g
          transform={`translate(${t.x + t.w / 2 - fs * 0.6} ${tagY + tagH / 2 - fs * 0.6}) scale(${(fs * 1.2) / 24})`}
        >
          <Icon name={t.sign as "segno" | "coda"} size={24} />
        </g>
      {/if}
    </g>
  {/each}
{/if}

<style>
  /* A system start: a blue bracket in the measure's label, before the
     number; white on a selected box's label. */
  .sysmark {
    fill: none;
    stroke: rgb(var(--layer-system));
    stroke-width: 2px;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .sysmark.on {
    stroke: #fff;
  }
  /* A repeat sign on its label: the label's ink, white on a selected box. */
  .repicon {
    color: #1a1a1a;
    pointer-events: none;
  }
  .repicon.on {
    color: #fff;
  }
  /* A sign's tag: paper with the measure's colour as its edge. */
  .signtag {
    pointer-events: none;
    color: #1a1a1a;
  }
  .signtag rect {
    fill: rgba(255, 255, 255, 0.94);
    stroke: rgba(var(--layer-measure), 0.85);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }
  .signtag text {
    font-family: var(--font);
    font-weight: 600;
    fill: #1a1a1a;
  }
  .labelbg {
    fill: rgba(255, 255, 255, 0.88);
    pointer-events: none;
  }
  .zonelabel {
    font-family: ui-monospace, monospace;
    font-weight: 600;
    fill: #1a1a1a;
    pointer-events: none;
  }
  /* The double bar of a section start, in the label's ink. */
  .dbar {
    fill: #1a1a1a;
    pointer-events: none;
  }
  .dbar.on {
    fill: #fff;
  }
  /* The selected measure's number label in the measure colour. */
  .labelbg.on {
    fill: rgb(var(--layer-measure));
  }
  .zonelabel.on {
    fill: #fff;
  }
</style>
