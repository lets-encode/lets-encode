<!--
  "Abandon" for a claim the viewer holds, confirmed in place: the first
  click turns the button into a question with the two answers beside it.
  Abandoning an edit claim deletes the viewer's unsubmitted changes; a review
  claim (`review`) has none.
-->
<script lang="ts">
  let {
    disabled = false,
    review = false,
    onabandon,
  }: {
    disabled?: boolean;
    review?: boolean;
    onabandon: () => void;
  } = $props();

  let asking = $state(false);
</script>

{#if asking}
  <span class="ask">
    <span class="q"
      >{review
        ? "Abandon this review?"
        : "Abandon this task? All your changes will be deleted."}</span
    >
    <button
      type="button"
      class="btn btn-soft"
      {disabled}
      onclick={() => {
        asking = false;
        onabandon();
      }}>Abandon</button
    >
    <button type="button" class="btn" onclick={() => (asking = false)}
      >{review ? "Keep reviewing" : "Keep working"}</button
    >
  </span>
{:else}
  <button
    type="button"
    class="btn btn-soft"
    {disabled}
    onclick={() => (asking = true)}
    title={review
      ? "Releases your review claim so someone else can review the task."
      : "Releases your claim and deletes your unsubmitted changes. The task is open to others again."}
    >Abandon</button
  >
{/if}

<style>
  .ask {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .q {
    font-size: 13px;
    color: var(--ink-soft);
  }
</style>
