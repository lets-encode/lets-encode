<!--
  The side panel of every campaign view, always shown. With a task it holds
  the host's task box pinned on top, the task's comments and the composer;
  without one (task '') it holds the campaign comments. Beside the content
  it is resizable by its left edge and the composer follows the comments. In
  portrait on a narrow screen (DOCKED_QUERY) it docks below the content at
  its content's height: closed, the header and the task box; opened, the
  comments (without a task, the campaign's details and comments) below them,
  up to DOCKED_MAX_CSS. The header's button, a tap on the top edge or a drag
  of it opens and closes it. Docked or on a touch screen the comment field
  shows only after its button or a Reply is pressed, and closes again when
  left empty. The width persists per browser (side-panels.ts).
-->
<script module lang="ts">
  // Whether resolved threads are hidden; held for the session across views.
  let hideResolved = $state(false);
</script>

<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { tick, type Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { Result } from "$lib/commands.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { buildThreads } from "$lib/campaign-board.ts";
  import {
    DOCKED_MAX_CSS,
    DOCKED_QUERY,
    defaultPanelWidth,
    hasStoredPanelWidth,
    type SidePanelState,
  } from "$lib/side-panels.ts";
  import Icon from "./Icon.svelte";
  import CommentCard from "./CommentCard.svelte";
  import CommentComposer from "./CommentComposer.svelte";
  import PanelResizeHandle from "./PanelResizeHandle.svelte";

  let {
    task,
    zone = 0,
    comments,
    logins,
    viewer,
    canPush,
    runner,
    panel = $bindable(),
    review = false,
    inScore = false,
    composerHint = "",
    emptyLine = "",
    banner,
    info,
    taskBox,
    ondeselect,
    onanchor,
    oncomment,
    onresolve,
  }: {
    /** The task the panel shows, or '' for the campaign. */
    task: string;
    /** The piece's colour slot, 1-based (--zone-N); 0 for none. */
    zone?: number;
    /** The whole comment log; the panel filters to its task. */
    comments: CommentRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    panel: SidePanelState;
    /** Tint the comments in the review colour. */
    review?: boolean;
    /** Anchor links read as in-view highlights instead of score links. */
    inScore?: boolean;
    /** Composer placeholder override (e.g. when a measure is selected). */
    composerHint?: string;
    /** The line shown in place of a task box, e.g. how to select a task. */
    emptyLine?: string;
    /** Rendered at the panel's top, e.g. the result of the last command. */
    banner?: Snippet;
    /** The campaign's details, above the campaign comments. */
    info?: Snippet;
    /** The task's record and controls, pinned above the comments. */
    taskBox?: Snippet;
    /** Return to the campaign; absent where the view is the task's own. */
    ondeselect?: () => void;
    /** Show a comment's measure range. */
    onanchor: (comment: CommentRow) => void;
    oncomment: (
      kind: string,
      body: string,
      parent_id: string,
    ) => Promise<Result | null>;
    onresolve: (comment_id: string) => Promise<unknown>;
  } = $props();

  const dockedQuery = new MediaQuery(DOCKED_QUERY, false);
  const docked = $derived(dockedQuery.current);
  // Docked, or in a window too short to hold the task box beside a list.
  const shortQuery = new MediaQuery("(max-height: 500px)", false);
  const cramped = $derived(dockedQuery.current || shortQuery.current);
  // Docked or on a touch screen the comment field opens on request.
  const coarseQuery = new MediaQuery("(pointer: coarse)", false);
  const fieldOnRequest = $derived(docked || coarseQuery.current);
  // Docked: whether the panel is opened past the header and the task box.
  let open = $state(false);
  let fieldOpen = $state(false);
  let draft = $state("");
  // The docked height in pixels while the top edge is dragged.
  let drag = $state<number | null>(null);
  // A drag shows the list it may open; the field only once opened.
  const listShown = $derived(!docked || open || drag !== null);
  const posting = $derived(pendingVerdicts.isProcessing(`comment:${task}`));
  // Until the viewer sets a width, the panel beside the content keeps its
  // default share of the window as the window changes.
  $effect(() => {
    if (docked) return;
    const fit = () => {
      if (!hasStoredPanelWidth())
        panel.width = defaultPanelWidth(window.innerWidth, window.innerHeight);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });

  const allThreads = $derived(buildThreads(comments, task));
  const count = $derived(
    allThreads.reduce((n, t) => n + 1 + t.replies.length, 0),
  );
  // A thread is resolved with its root comment.
  const resolvedCount = $derived(
    allThreads.filter((t) => t.root.resolved === "true").length,
  );
  const threads = $derived(
    hideResolved
      ? allThreads.filter((t) => t.root.resolved !== "true")
      : allThreads,
  );

  // The comment a reply targets, shared by the thread list and the composer;
  // cleared when the panel changes task.
  let replyTo = $state<CommentRow | null>(null);
  $effect.pre(() => {
    void task;
    replyTo = null;
    open = false;
    fieldOpen = false;
  });

  // What opening the docked panel adds below the header and the task box.
  const hasMore = $derived(count > 0 || (!task && !!info));
  const fieldShown = $derived(
    (!docked || open) && (!fieldOnRequest || fieldOpen || !!replyTo),
  );
  const writeShown = $derived((!docked || open) && !fieldShown && !!auth.user);
  const writeLabel = $derived(
    composerHint ? composerHint.replace(/…$/, "") : "Write a comment",
  );
  const toggleLabel = $derived(
    !task && info
      ? `Details and comments · ${count}`
      : count > 0
        ? `Comments · ${count}`
        : "Comment",
  );

  let aside = $state<HTMLElement>();
  async function focusField() {
    await tick();
    aside?.querySelector<HTMLInputElement>(".composerwrap input")?.focus();
  }
  function openField() {
    open = true;
    fieldOpen = true;
    focusField();
  }
  function startReply(c: CommentRow) {
    replyTo = c;
    open = true;
    focusField();
  }
  // Closing keeps a draft; an empty field closes with the panel.
  function closePanel() {
    open = false;
    if (!draft.trim() && !replyTo) fieldOpen = false;
  }
  // The field's focus leaves before the header button's click lands, so the
  // click acts on whether the panel was open at the press.
  let openAtPress: boolean | null = null;
  function toggle() {
    const wasOpen = openAtPress ?? open;
    openAtPress = null;
    if (wasOpen) closePanel();
    else if (hasMore) open = true;
    else openField();
  }
  // With nothing else to show, the panel closes with the field.
  function closeField() {
    fieldOpen = false;
    if (!hasMore) open = false;
  }
  // Focus leaving an empty field closes it.
  function fieldBlur(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && (e.currentTarget as HTMLElement).contains(to)) return;
    if (fieldOnRequest && !draft.trim() && !replyTo && !posting) closeField();
  }

  // A drag past DOCK_STEP pixels opens or closes the docked panel.
  const DOCK_STEP = 48;
  function dockEnd(height: number, startHeight: number) {
    if (height - startHeight > DOCK_STEP && hasMore) open = true;
    else if (startHeight - height > DOCK_STEP) closePanel();
  }
  function dockTap() {
    if (open) closePanel();
    else if (hasMore) open = true;
  }
  function dockStep(dir: 1 | -1) {
    if (dir === 1 && hasMore) open = true;
    else if (dir === -1) closePanel();
  }
  const dockText = $derived(
    open
      ? task
        ? "Task and comments"
        : "Details and comments"
      : task
        ? "Task only"
        : "Closed",
  );
</script>

{#snippet composer()}
  {#if writeShown}
    <div class="composerwrap">
      <button type="button" class="btn writebtn" onclick={openField}
        ><Icon name="plus" /> {writeLabel}</button
      >
    </div>
  {/if}
  <div class="composerwrap" class:hidden={!fieldShown} onfocusout={fieldBlur}>
    <CommentComposer
      {task}
      {logins}
      {runner}
      bind:replyTo
      bind:text={draft}
      placeholder={composerHint ||
        (task ? "Comment on this task…" : "Comment on the campaign…")}
      {oncomment}
      oncancel={fieldOnRequest ? closeField : undefined}
    />
  </div>
{/snippet}

<div
  class="spwrap"
  class:docked
  class:cramped
  class:dragging={drag !== null}
  style={docked
    ? `max-height: ${DOCKED_MAX_CSS}` +
      (drag !== null ? `; height: ${drag}px` : "")
    : `width: ${panel.width}px`}
>
  <PanelResizeHandle
    label="Resize the side panel"
    bind:panel
    bind:drag
    {docked}
    dockLevel={open ? 1 : 0}
    dockMin={0}
    dockLevels={2}
    {dockText}
    dockUp={!open && hasMore}
    dockDown={open}
    ondockend={dockEnd}
    ondockstep={dockStep}
    ondocktap={dockTap}
  />
  <aside
    bind:this={aside}
    class="sp"
    style={zone ? `--zone: var(--zone-${zone})` : ""}
    aria-label={task ? "Task" : "Campaign"}
  >
    {@render banner?.()}
    <div class="sphead">
      {#if ondeselect}
        <button
          type="button"
          class="btn deselect"
          title="Deselect the task and show the campaign comments"
          onclick={ondeselect}><Icon name="arrow-left" /> Campaign</button
        >
        <span class="sep" aria-hidden="true">/</span>
      {/if}
      <h2 class="sptitle">{task ? "Task" : "Campaign"}</h2>
      {#if docked && (hasMore || auth.user)}
        <button
          type="button"
          class="btn showinline"
          aria-pressed={open}
          onpointerdown={() => (openAtPress = open)}
          onclick={toggle}
          >{#if posting}<span
              class="spinner"
              title="Processing comment"
              aria-label="Processing comment"
            ></span>{/if}{toggleLabel}</button
        >
      {/if}
    </div>
    {#if taskBox}
      <div class="pinhead">{@render taskBox()}</div>
    {:else if emptyLine && listShown}
      <p class="empty">{emptyLine}</p>
    {/if}
    {#if listShown}
      <div class="clist">
        {#if !task}{@render info?.()}{/if}
        <!-- In a docked or short panel, no comments means no list: the
             composer sits right under the task box. -->
        {#if !(cramped && count === 0 && (task || !info))}
          <div class="sechead" class:review>
            <span class="secdot"></span>
            {task ? "Comments" : "Campaign comments"}
            <span class="seccount">{count}</span>
            {#if resolvedCount > 0}
              <button
                type="button"
                class="chip-switch"
                class:on={hideResolved}
                onclick={() => (hideResolved = !hideResolved)}
                title="Hide the resolved threads"
                ><span class="sw"></span>Hide resolved · {resolvedCount}</button
              >
            {/if}
          </div>
          {#each threads as t (t.root.comment_id)}
            <CommentCard
              comment={t.root}
              {logins}
              {viewer}
              {canPush}
              {runner}
              {review}
              {inScore}
              {onanchor}
              onreply={t.root.kind === "comment" ? startReply : undefined}
              {onresolve}
            />
            {#each t.replies as reply (reply.comment_id)}
              <CommentCard
                comment={reply}
                {logins}
                {viewer}
                {canPush}
                {runner}
                {review}
                reply
                {inScore}
                {onanchor}
                {onresolve}
              />
            {/each}
          {/each}
          {#if threads.length === 0}
            <span class="cnone"
              >{allThreads.length === 0
                ? "No comments yet."
                : `${resolvedCount} resolved ${resolvedCount === 1 ? "thread" : "threads"} hidden.`}</span
            >
          {/if}
        {/if}
      </div>
    {/if}
    {@render composer()}
  </aside>
</div>

<style>
  /* Beside the content the panel runs the full row height. */
  .spwrap {
    flex: none;
    display: flex;
    min-height: 0;
    min-width: 0;
    align-self: stretch;
    /* The stored width is an inline style; a narrow window caps it as
       clampPanelWidth does (side-panels.ts). */
    max-width: max(280px, min(50vw, calc(100vw - 474px)));
  }
  /* Docked below the content: full width, the grip on the top edge, as tall
     as its content up to its inline max-height. After a drag the height
     returns to its content's, animated where height: auto interpolates. */
  .spwrap.docked {
    flex: none;
    flex-direction: column;
    max-width: none;
    width: 100%;
    interpolate-size: allow-keywords;
    transition: height 200ms cubic-bezier(0.22, 1, 0.36, 1);
    border-top: 1px solid var(--line-strong);
    box-shadow: 0 -2px 8px var(--shade);
    background: var(--bg-inset);
  }
  .spwrap.docked.dragging {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .spwrap.docked {
      transition: none;
    }
  }
  .sp {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    border-radius: 12px;
    padding: 12px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .docked .sp {
    border-radius: 0;
    box-shadow: none;
    padding: 4px 12px 16px;
  }
  .sp :global(.banner) {
    margin: 0;
  }
  .sphead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .deselect {
    flex: none;
  }
  .sep {
    color: var(--ink-faint);
  }
  .sptitle {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
  }
  /* The task box keeps its full height so its controls never scroll away
     inside it, and the composer stays at the bottom: beside the content only
     the comment list between them scrolls, down to its minimum height. Past
     that, and always when docked, the panel scrolls as a whole. */
  .pinhead {
    flex: none;
  }
  /* The composer follows the comments; once they overflow it stays at the
     panel's bottom. The shadow fills the panel's bottom padding, so content
     scrolling under the composer does not show below it. */
  .composerwrap {
    flex: none;
    position: sticky;
    bottom: 0;
    background: var(--bg-inset);
    box-shadow: 0 16px 0 var(--bg-inset);
    padding-top: 6px;
  }
  .composerwrap.hidden {
    display: none;
  }
  /* Docked or in a short window the list is no scroll area of its own: the
     panel scrolls as one, the comments right below the task box. */
  .cramped .clist {
    flex: none;
    min-height: 0;
    overflow-y: visible;
  }
  .sphead :global(.btn) {
    padding: 4px 12px;
  }
  .empty {
    flex: none;
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-soft);
    padding: 2px 2px;
  }
  .showinline {
    margin-left: auto;
    flex: none;
  }
  .docked .sphead :global(.btn) {
    min-height: 40px;
  }
  .showinline[aria-pressed="true"] {
    color: var(--accent);
    background: var(--accent-tint-strong);
    border-color: var(--accent-line-strong);
  }
  .writebtn {
    width: 100%;
    min-height: 44px;
    justify-content: center;
    border-style: dashed;
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
  .clist {
    flex: 0 1 auto;
    /* Room for the list heading and a line below it. */
    min-height: 50px;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sechead {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-soft);
    padding: 4px 2px 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sechead.review {
    color: var(--warn);
  }
  .secdot {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: currentColor;
    flex: none;
  }
  .seccount {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    border-radius: 999px;
    line-height: 1;
    padding: 3px 7px;
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
  }
  .sechead .chip-switch {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .cnone {
    font-size: 11.5px;
    color: var(--ink-soft);
    padding: 4px 2px;
  }
</style>
