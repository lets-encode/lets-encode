<!--
  The editor units on pages of their own, with fixture documents and no
  campaign, task or login. Development only: a production build holds
  neither these pages nor their fixtures.
-->
<script lang="ts">
  import { page } from "$app/state";
  import type { Component } from "svelte";

  const units: Record<
    string,
    { name: string; load: () => Promise<{ default: Component }> }
  > = import.meta.env.DEV
    ? {
        preview: {
          name: "Score preview",
          load: () => import("$lib/unit-pages/PreviewUnit.svelte"),
        },
        align: {
          name: "Encoding alignment",
          load: () => import("$lib/unit-pages/AlignUnit.svelte"),
        },
        corrector: {
          name: "Measure correction",
          load: () => import("$lib/unit-pages/CorrectorUnit.svelte"),
        },
        setup: {
          name: "Score setup",
          load: () => import("$lib/unit-pages/SetupUnit.svelte"),
        },
      }
    : {};
  const unit = $derived(units[page.params.unit ?? ""]);
</script>

<svelte:head>
  <title>{unit?.name ?? "Units"} · Let's Encode!</title>
</svelte:head>

{#if unit}
  {#await unit.load() then module}
    <module.default />
  {/await}
{:else if page.params.unit || !import.meta.env.DEV}
  <p class="msg perr">This page does not exist.</p>
{:else}
  <ul class="units">
    {#each Object.entries(units) as [path, { name }] (path)}
      <li><a href={`/units/${path}`}>{name}</a></li>
    {/each}
  </ul>
{/if}

<style>
  .units {
    margin: 24px;
  }
</style>
