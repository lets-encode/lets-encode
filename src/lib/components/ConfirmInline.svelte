<!--
  A confirmation in place of the control that asked for it: the question,
  the confirming button (danger, or soft where nothing is lost) and Cancel.
  `stacked` puts the question on its own line above the buttons, for a
  question longer than a few words. Rich text goes in `children`.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    question,
    children,
    confirm,
    onconfirm,
    oncancel,
    soft = false,
    disabled = false,
    stacked = false,
  }: {
    question?: string;
    /** The question as markup, in place of `question`. */
    children?: Snippet;
    /** The confirming button's label. */
    confirm: string;
    onconfirm: () => void;
    oncancel: () => void;
    soft?: boolean;
    disabled?: boolean;
    stacked?: boolean;
  } = $props();
</script>

<span class="ask" class:stacked>
  <span class="q"
    >{#if children}{@render children()}{:else}{question}{/if}</span
  >
  <span class="btns">
    <button
      type="button"
      class="btn {soft ? 'btn-soft' : 'btn-danger'}"
      {disabled}
      onclick={onconfirm}>{confirm}</button
    >
    <button type="button" class="btn" onclick={oncancel}>Cancel</button>
  </span>
</span>

<style>
  .ask {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ask.stacked {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .q {
    font-size: 13px;
    color: var(--ink-soft);
  }
  .q :global(a) {
    color: var(--link);
  }
  .btns {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
  }
</style>
