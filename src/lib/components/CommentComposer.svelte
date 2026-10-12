<!--
  The discussion composer: a comment on the task, or a reply to the
  bound comment (set by the host's Reply buttons). With oncancel it has a
  Cancel button that clears the draft. Renders nothing for a logged-out
  viewer.
-->
<script lang="ts">
  import type { Result } from "$lib/commands.ts";
  import { auth } from "$lib/auth.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { handle } from "$lib/campaign-graph.ts";

  let {
    task,
    logins,
    runner,
    replyTo = $bindable(),
    text = $bindable(""),
    oncomment,
    oncancel,
    placeholder = "Write a comment…",
  }: {
    /** The task id the composer posts to, e.g. "T0002". */
    task: string;
    logins: Record<string, string>;
    runner: CommandRunner;
    /** The comment a reply is being written to, shared with the thread list. */
    replyTo: CommentRow | null;
    /** The draft. */
    text?: string;
    oncomment: (
      kind: string,
      body: string,
      parent_id: string,
    ) => Promise<Result | null>;
    /** Cancel was pressed; the draft and the reply target are cleared. */
    oncancel?: () => void;
    placeholder?: string;
  } = $props();

  let sending = $state(false);
  // Pending from Send until the comment PR's verdict lands: first the
  // foreground command, then its background entry in the verdict store.
  const posting = $derived(
    sending || pendingVerdicts.isProcessing(`comment:${task}`),
  );

  async function postComment() {
    if (!text.trim()) return;
    const kind = replyTo ? "reply" : "comment";
    const parent_id = replyTo?.comment_id ?? "";
    sending = true;
    let result: Result | null;
    try {
      result = await oncomment(kind, text, parent_id);
    } finally {
      sending = false;
    }
    if (result?.ok) {
      text = "";
      replyTo = null;
    }
  }

  function cancel() {
    text = "";
    replyTo = null;
    oncancel?.();
  }

  const commentLogin = (c: CommentRow) => handle(logins, c.author_id);
</script>

{#if auth.user}
  <div class="composer">
    {#if replyTo}
      <div class="replying">
        Replying to <strong>{commentLogin(replyTo)}</strong>
        <button type="button" class="linkish" onclick={() => (replyTo = null)}
          >Cancel</button
        >
      </div>
    {/if}
    {#if posting}
      <div class="posting">
        <span class="spinner" aria-hidden="true"></span>
        Processing comment…
      </div>
    {/if}
    <div class="composer-row">
      <input
        bind:value={text}
        {placeholder}
        aria-label="Comment text"
        onkeydown={(e) => {
          if (e.key === "Enter" && text.trim() && !runner.busy) postComment();
        }}
      />
      {#if oncancel}
        <button type="button" class="btn" onclick={cancel}>Cancel</button>
      {/if}
      <button
        type="button"
        class="btn btn-soft"
        onclick={postComment}
        disabled={runner.busy || !text.trim()}>Send</button
      >
    </div>
  </div>
{/if}

<style>
  .linkish {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    cursor: pointer;
  }
  .composer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 10px;
  }
  .replying {
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .posting {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .spinner {
    flex: none;
    width: 10px;
    height: 10px;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
  }
  .composer-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .composer-row input {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-family: inherit;
    padding: 8px 12px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
  }
</style>
