<!--
  The campaign's views start over for each campaign and task: a navigation to
  another task (or campaign) mounts the page anew instead of reusing it, so no
  state of the previous task carries over. The campaign page takes its task
  from the query, which does not remount it.
-->
<script lang="ts">
  import { page } from "$app/state";

  let { children } = $props();
</script>

{#key `${page.params.campaign}/${page.params.task ?? ""}`}
  {@render children()}
{/key}
