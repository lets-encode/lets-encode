<!--
  The discussion composer: a comment on the task, or a reply to the
  bound comment (set by the host's Reply buttons). Cancel clears the draft
  and the reply target, then calls oncancel; without oncancel it is
  disabled while there is nothing to clear. Renders nothing for a
  logged-out viewer. The field grows with its text up to a maximum height; with a
  mouse Enter sends and Shift+Enter starts a new line, on a touch screen
  Enter starts a new line.
-->
<script lang="ts">
  import type { Result } from "$lib/commands.ts";
  import { auth } from "$lib/auth.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import { MAX_COMMENT_LENGTH } from "$lib/campaign-submit.ts";

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

  const uid = $props.id();
  let sending = $state(false);
  // Pending from Send until the comment PR's verdict lands: first the
  // foreground command, then its background entry in the verdict store.
  const posting = $derived(
    sending || pendingVerdicts.isProcessing(`comment:${task}`),
  );

  async function postComment() {
    if (!text.trim() || text.length > MAX_COMMENT_LENGTH) return;
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

  let field = $state<HTMLTextAreaElement>();
  // Fits the field's height to its text; CSS caps it with max-height. A
  // hidden field has no layout to measure and keeps its CSS height.
  function fit() {
    if (!field) return;
    if (!field.offsetWidth) {
      field.style.height = "";
      return;
    }
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }
  $effect(() => {
    void text;
    fit();
  });
  // A change of width (shown, or the panel resized) rewraps the text.
  $effect(() => {
    if (!field) return;
    let width = -1;
    const observer = new ResizeObserver(() => {
      if (field!.offsetWidth === width) return;
      width = field!.offsetWidth;
      fit();
    });
    observer.observe(field);
    return () => observer.disconnect();
  });

  function keydown(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    if (text.trim() && !runner.busy) postComment();
  }
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
    <textarea
      bind:this={field}
      bind:value={text}
      {placeholder}
      rows="1"
      aria-label="Comment text"
      aria-describedby={text.length >= MAX_COMMENT_LENGTH * 0.9
        ? `${uid}-count`
        : undefined}
      maxlength={MAX_COMMENT_LENGTH}
      onkeydown={keydown}
    ></textarea>
    <!-- The count shows once the text nears the limit. -->
    {#if text.length >= MAX_COMMENT_LENGTH * 0.9}
      <span
        id={`${uid}-count`}
        class="hint"
        class:hint-err={text.length > MAX_COMMENT_LENGTH}
        aria-live="polite">{text.length}/{MAX_COMMENT_LENGTH} characters</span
      >
    {/if}
    <div class="composer-actions">
      <button
        type="button"
        class="btn"
        onclick={cancel}
        disabled={!oncancel && !text && !replyTo}>Cancel</button
      >
      <button
        type="button"
        class="btn btn-soft"
        onclick={postComment}
        disabled={runner.busy ||
          !text.trim() ||
          text.length > MAX_COMMENT_LENGTH}>Send</button
      >
    </div>
  </div>
{/if}

<style>
  .composer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  .composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  textarea {
    box-sizing: border-box;
    max-height: calc(8lh + 18px);
    resize: none;
    font-size: 14px;
    font-family: inherit;
    line-height: 1.4;
    padding: 8px 14px;
    border: 1px solid var(--line-input);
    border-radius: 17px;
    background: var(--card);
    color: var(--ink);
  }
  /* On a touch screen the field starts at two lines. */
  @media (pointer: coarse) {
    textarea {
      min-height: calc(2lh + 22px);
      padding: 10px 14px;
    }
  }
</style>
