<!--
  "Give back" for a claim the viewer holds, confirmed in place: the first
  click turns the button into a question with the two answers beside it.
  Giving back an edit claim deletes the viewer's unsubmitted changes, so its
  confirming button is the danger outline; a review claim (`review`) has none.
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
        ? "Give back this review?"
        : "Give back this task? All your changes will be deleted."}</span
    >
    <button
      type="button"
      class="btn {review ? 'btn-soft' : 'btn-danger'}"
      {disabled}
      onclick={() => {
        asking = false;
        onabandon();
      }}>{review ? "Give back" : "Give back and delete changes"}</button
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
    >Give back</button
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
