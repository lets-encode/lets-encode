<!--
  What can be done when the organisation chosen as the campaign's owner did
  not create its repository: ask for the app's approval on GitHub, when the
  organisation does not allow the app, or choose another owner.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import { provider } from "$lib/forge/config.ts";
  import type { OwnerRefusedError } from "$lib/campaign-repo.ts";
  import { wizard } from "$lib/wizard.svelte.ts";

  let { refused }: { refused: OwnerRefusedError } = $props();
</script>

<div class="refused-actions">
  {#if refused.restricted}
    <a
      class="btn"
      href="{provider.brokerUrl}/app-access"
      target="_blank"
      rel="noopener"
      >Request approval on GitHub <Icon name="external" size={12} /></a
    >
  {/if}
  <button type="button" class="btn" onclick={() => (wizard.step = "name")}>
    Change the owner
  </button>
</div>

<style>
  .refused-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
</style>
