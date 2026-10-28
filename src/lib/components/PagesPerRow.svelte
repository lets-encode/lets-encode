<!--
  How many pages a row of previews holds. A tile takes an equal share of the
  width it has, so fewer per row shows each page larger.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    value = $bindable(),
  }: {
    /** Pages per row, between 1 and MOST. */
    value: number;
  } = $props();
  const MOST = 5;
</script>

<span class="tbtn-pair">
  <button
    type="button"
    class="tbtn tbtn-icon"
    aria-label="Fewer pages per row"
    title="Fewer pages per row"
    disabled={value <= 1}
    onclick={() => value--}
  >
    <Icon name="minus" size={16} />
  </button>
  <span class="tval" title="{value} per row"
    >{value}<span class="per-row-word">per row</span></span
  >
  <button
    type="button"
    class="tbtn tbtn-icon"
    aria-label="More pages per row"
    title="More pages per row"
    disabled={value >= MOST}
    onclick={() => value++}
  >
    <Icon name="plus" size={16} />
  </button>
</span>

<style>
  .per-row-word {
    margin-left: 0.3em;
  }
  @container material (max-width: 439px) {
    .per-row-word {
      display: none;
    }
  }
</style>
