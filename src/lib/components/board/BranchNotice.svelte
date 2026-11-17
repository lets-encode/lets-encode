<!--
  The dev server's branch hint (branch-hint.svelte.ts): a notice strip, and
  the same hint as a dialog the first time the campaign opens in a browser
  session.
-->
<script lang="ts">
  import Notice from "$lib/components/Notice.svelte";
  import type { BranchHint } from "$lib/campaign-page/branch-hint.svelte.ts";

  let {
    branch,
    hint,
  }: {
    branch: BranchHint;
    hint: { ref: string; called: string };
  } = $props();
</script>

<Notice
  tone="warn"
  surface="strip"
  title="This campaign runs a different branch"
>
  <span>
    Dev server: the campaign runs the coordinator from <code>{hint.ref}</code>
    but <code>campaign.yml</code> from <code>{hint.called}</code>, so
    submissions can be skipped or rejected. In
    <code>lets-encode/</code>
    on <code>{hint.ref}</code>, run
    <code>{branch.command}</code>, then reload.
  </span>
</Notice>
<dialog
  bind:this={branch.dialog}
  class="dialog branch-dialog"
  aria-labelledby="branch-dialog-title"
  onclick={(e) => {
    if (e.target === branch.dialog) branch.dialog?.close();
  }}
>
  <h2 class="sectitle" id="branch-dialog-title">
    Point the campaign at its branch
  </h2>
  <p>
    Dev server: this campaign runs the coordinator from <code>{hint.ref}</code>
    but <code>campaign.yml</code> from <code>{hint.called}</code>, so
    submissions can be skipped or rejected. In
    <code>lets-encode/</code> on <code>{hint.ref}</code>, run:
  </p>
  <pre><code>{branch.command}</code></pre>
  <div class="branch-actions">
    <button
      type="button"
      class="btn"
      onclick={() =>
        navigator.clipboard
          .writeText(branch.command)
          .then(() => (branch.copied = true))
          .catch(() => {})}>{branch.copied ? "Copied" : "Copy command"}</button
    >
    <button
      type="button"
      class="btn btn-primary"
      onclick={() => branch.dialog?.close()}>Close</button
    >
  </div>
</dialog>

<style>
  /* The dev server's branch hint as a dialog after the campaign opens. */
  .branch-dialog {
    width: 640px;
    max-width: calc(100vw - 32px);
    padding: 20px 24px;
  }
  .branch-dialog h2 {
    margin: 0 0 8px;
  }
  .branch-dialog pre {
    margin: 12px 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--bg-inset);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .branch-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
