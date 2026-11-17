<!--
  The encoding alignment's footer: the measures placed from the file, the
  host's status, and Submit, held while the file is another piece or the
  merged score has a problem.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { differentReason } from "$lib/encoding-align.ts";
  import type { AlignedEncoding } from "$lib/encoding-merge.ts";
  import WorkspaceFooter from "$lib/components/WorkspaceFooter.svelte";

  let {
    aligned,
    canEdit,
    busy,
    status,
    onsubmit,
  }: {
    aligned: AlignedEncoding;
    canEdit: boolean;
    /** A submission or another command is running. */
    busy: boolean;
    /** The host's status beside Submit. */
    status: Snippet;
    onsubmit: () => void;
  } = $props();
</script>

<WorkspaceFooter {status}>
  {#snippet summary()}
    {aligned.summary.filled} of {aligned.layout.length} measures from the file
    {#if aligned.summary.empty}· {aligned.summary.empty} empty{/if}
  {/snippet}
  <button
    type="button"
    class="btn btn-primary btn-pre"
    onclick={onsubmit}
    disabled={busy ||
      !canEdit ||
      aligned.summary.kind === "different" ||
      aligned.problems.length > 0}
    title={aligned.summary.kind === "different"
      ? differentReason(aligned.summary)
      : aligned.problems.length
        ? "The merged score names staves or elements it does not contain. Fix the problems listed in the panel first."
        : "Submit the measures placed from the file for review"}
  >
    Submit alignment
  </button>
</WorkspaceFooter>
