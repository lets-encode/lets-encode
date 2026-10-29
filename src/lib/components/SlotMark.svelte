<!--
  The mark of one review slot: the green hand for an approval, a dot for a
  change request, a held review or an empty slot. Its label names the state
  and, when given, the reviewer.
-->
<script module lang="ts">
  /** How a slot's state reads. */
  export const slotLabel = (key: string): string =>
    ({
      pass: "approved",
      fail: "changes requested",
      review: "in review",
    })[key] ?? key;
</script>

<script lang="ts">
  let { key, who = "" }: { key: string; who?: string } = $props();
  const label = $derived(who ? `${slotLabel(key)}: ${who}` : slotLabel(key));
</script>

{#if key === "pass"}
  <img class="hand-pass" src="/green-hand.svg" alt={label} title={label} />
{:else}
  <span class="dot {key}" role="img" aria-label={label} title={label}></span>
{/if}

<style>
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line-input);
    flex: none;
    display: inline-block;
  }
  .hand-pass {
    height: 14px;
    flex: none;
  }
  .dot.fail {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
  }
  .dot.review {
    background: var(--info-bg);
    border-color: var(--info);
  }
</style>
