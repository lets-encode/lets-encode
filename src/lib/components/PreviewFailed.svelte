<!--
  The place of a piece preview whose load failed: "Preview failed" in the
  danger colour over a "Try again" link-coloured line, as one button that
  loads the preview again.
-->
<script lang="ts">
  let { onretry }: { onretry: () => void } = $props();
</script>

<button
  type="button"
  class="previewfailed"
  title="Load the preview again"
  onclick={onretry}>Preview failed<span class="retry">Try again</span></button
>

<style>
  .previewfailed {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 24px;
    padding: 0 6px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
    text-align: center;
    color: var(--danger);
    background: none;
    border: 0;
    cursor: pointer;
  }
  .retry {
    color: var(--link);
  }
  @media (hover: hover) {
    .previewfailed:hover .retry {
      text-decoration: underline;
    }
  }
</style>
