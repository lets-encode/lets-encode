<!--
  "Give back task" for a claim the viewer holds, confirmed in place: the first
  click turns the button into a question with the two answers beside it.
  Giving back an edit claim deletes the viewer's unsubmitted changes, so its
  confirming button is the danger outline; a review claim (`review`) has none.
-->
<script lang="ts">
  import ConfirmInline from "./ConfirmInline.svelte";

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
  <ConfirmInline
    question={review
      ? "Give back this review?"
      : "Give back this task? All your changes will be deleted."}
    confirm={review ? "Give back task" : "Give back task and delete changes"}
    soft={review}
    {disabled}
    onconfirm={() => {
      asking = false;
      onabandon();
    }}
    oncancel={() => (asking = false)}
  />
{:else}
  <button
    type="button"
    class="btn btn-soft"
    {disabled}
    onclick={() => (asking = true)}
    title={review
      ? "Releases your review claim so someone else can review the task."
      : "Releases your claim and deletes your unsubmitted changes. The task is open to others again."}
    >Give back task</button
  >
{/if}
