<!--
  The campaign list's toolbar: the search field and the sort control, then
  the "All campaigns" heading with its count and the filter. Phones show the
  sort as an icon.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import {
    SORT_LABELS as sortLabels,
    type ListFilter,
    type ListSort,
  } from "$lib/campaign-list/list-query.ts";

  let {
    search = $bindable(),
    sort = $bindable(),
    filter = $bindable(),
    searchInput = $bindable(),
    count,
    failed,
    showYours,
  }: {
    search: string;
    sort: ListSort;
    filter: ListFilter;
    /** The search field, for returning focus to it. */
    searchInput: HTMLInputElement | undefined;
    /** The heading's count: matching campaigns, or "…" while loading. */
    count: number | string;
    /** Campaigns that could not be loaded. */
    failed: number;
    /** The "Yours" filter is offered (a viewer is logged in). */
    showYours: boolean;
  } = $props();
</script>

<div class="tools">
  <label class="search">
    <Icon name="search" />
    <input
      type="search"
      bind:value={search}
      bind:this={searchInput}
      placeholder="Title, composer or piece"
      aria-label="Search campaigns"
    />
  </label>
  <label class="btn on-tint sort" title={`Sort campaigns: ${sortLabels[sort]}`}>
    <Icon name="sort" />
    <span class="sortlabel">{sortLabels[sort]}</span>
    <span class="sortchev"><Icon name="chevron-down" size={12} /></span>
    {#if sort !== "active"}<span class="statusdot sortdot"></span>{/if}
    <select bind:value={sort} aria-label="Sort campaigns">
      <option value="active">{sortLabels.active}</option>
      <option value="newest">{sortLabels.newest}</option>
      <option value="progress">{sortLabels.progress}</option>
    </select>
  </label>
</div>
<div class="shead">
  <div class="phead">
    <h2 class="sectitle">All campaigns</h2>
    <span
      class="countpill"
      title={failed > 0 ? `${failed} more could not be loaded` : undefined}
      >{count}</span
    >
  </div>
  <div class="seg" role="group" aria-label="Filter campaigns">
    <button
      type="button"
      class:on={filter === "all"}
      aria-pressed={filter === "all"}
      onclick={() => (filter = "all")}>All</button
    >
    <button
      type="button"
      class:on={filter === "open"}
      aria-pressed={filter === "open"}
      onclick={() => (filter = "open")}>Open to claim</button
    >
    <button
      type="button"
      class:on={filter === "nearly"}
      aria-pressed={filter === "nearly"}
      title="Campaigns with at least 80% of their tasks done"
      onclick={() => (filter = "nearly")}>Nearly done</button
    >
    {#if showYours}
      <button
        type="button"
        class="yoursopt"
        class:on={filter === "yours"}
        aria-pressed={filter === "yours"}
        onclick={() => (filter = "yours")}>Yours</button
      >
    {/if}
  </div>
</div>

<style>
  .tools {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .search {
    flex: 1;
    min-width: 0;
    max-width: 520px;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    box-sizing: border-box;
    color: var(--ink-faint);
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 8px;
  }
  /* The input has no outline of its own; the field shows the focus. */
  .search:focus-within {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    min-height: 32px;
    padding: 0;
    font: 400 14px var(--font);
    color: var(--ink);
    background: transparent;
    border: 0;
    outline: none;
  }
  .search input::placeholder {
    color: var(--ink-faint);
  }
  /* The sort control is a native select laid transparently over a button
     face, so the platform's own menu opens. */
  .sort {
    position: relative;
    flex: none;
  }
  .sort:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .sortchev {
    display: flex;
  }
  /* Phones show the sort as an icon; a dot marks a sort other than the
     default. */
  .sortdot {
    display: none;
  }
  .sort select {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
    cursor: pointer;
  }
  @media (max-width: 560px) {
    .sort {
      width: 32px;
      padding: 0;
      justify-content: center;
    }
    .sortlabel,
    .sortchev {
      display: none;
    }
    .sortdot {
      display: block;
      position: absolute;
      top: 3px;
      right: 3px;
      color: var(--accent);
    }
  }
  .shead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 12px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .shead .seg {
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }
  /* The owner orange reaches 4.5:1 on the grey track only in its deeper
     tone; the dark theme's light orange already does. */
  .seg > button.yoursopt {
    color: var(--warn-btn-hover);
  }
  :global([data-theme="dark"]) .seg > button.yoursopt {
    color: var(--owner);
  }
</style>
