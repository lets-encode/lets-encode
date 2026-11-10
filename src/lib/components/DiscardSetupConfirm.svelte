<!--
  The question before an unfinished setup is discarded (ConfirmInline), in
  the wizard and in the list of drafts: everything entered goes, and where
  the setup already made its repository, the repository stays.
-->
<script lang="ts">
  import type { WizardRepo } from "$lib/wizard.svelte.ts";
  import ConfirmInline from "./ConfirmInline.svelte";

  let {
    repo,
    onconfirm,
    oncancel,
    disabled = false,
  }: {
    repo: WizardRepo | null;
    onconfirm: () => void;
    oncancel: () => void;
    disabled?: boolean;
  } = $props();
</script>

<ConfirmInline
  confirm="Discard for good"
  {onconfirm}
  {oncancel}
  {disabled}
  stacked
>
  Discard everything entered so far?{#if repo}
    Discarding frees the name but leaves the repository
    <a href={repo.html_url} target="_blank" rel="noreferrer">{repo.full_name}</a
    > — delete it yourself if you don't want it.{/if}
</ConfirmInline>
