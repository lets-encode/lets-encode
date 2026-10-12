<!--
  The side panel of every campaign view, always shown. With a task it holds
  the host's task box pinned on top, the task's comments and the composer;
  without one (task '') it holds the campaign comments. Beside the content
  it is resizable by its left edge; in portrait on a narrow screen
  (DOCKED_QUERY) it docks below the content at one of three heights
  (PANEL_SNAPS), dragged by its top edge and snapped on release, a tap on
  the edge moving to the next height. At the lowest height a task's comment
  field gives way to a Comment button in the header that raises the panel. Docked
  without a task it starts as a bar holding the campaign comment field, with
  a button that opens the list; dragging the bar up opens it too, dragging
  the open list below its lowest height closes it. Sizes persist per browser
  (side-panels.ts).
-->
<script module lang="ts">
  // Whether resolved threads are hidden; held for the session across views.
  let hideResolved = $state(false);
</script>

<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { tick, type Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { Result } from "$lib/commands.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { buildThreads } from "$lib/campaign-board.ts";
  import {
    DOCKED_QUERY,
    PANEL_SNAPS,
    SNAP_CSS,
    defaultPanelWidth,
    hasStoredPanelWidth,
    nearestSnap,
    snapHeight,
    stepSnap,
    writeSidePanel,
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
  // Docked without a task, the campaign comments open only on request.
  let campaignOpen = $state(false);
  // The docked height in pixels while the top edge is dragged.
  let drag = $state<number | null>(null);
  const collapsedCampaign = $derived(
    docked && !task && !campaignOpen && drag === null,
  );

  // Docked, the bar is step 0 and the snaps follow.
  const dockLevel = $derived(
    collapsedCampaign ? 0 : PANEL_SNAPS.indexOf(panel.snap) + 1,
  );
  const SNAP_TEXT = {
    peek: "Low height",
    half: "Half height",
    full: "Full height",
  } as const;
  const dockText = $derived(
    collapsedCampaign ? "Comment field only" : SNAP_TEXT[panel.snap],
  );

  function setSnap(snap: SidePanelState["snap"]) {
    panel.snap = snap;
    writeSidePanel({ ...panel }, "snap");
  }
  // Without a task, a release well below the lowest snap closes the list
  // back to the bar.
  function dockEnd(height: number) {
    const peek = snapHeight("peek", window.innerHeight);
    if (!task && height < peek * 0.75) {
      campaignOpen = false;
      return;
    }
    if (!task) campaignOpen = true;
    setSnap(nearestSnap(height, window.innerHeight));
  }
  // A tap on the bar moves up one height, from the highest back to the
  // lowest (without a task, back to the comment field).
  function dockTap() {
    if (collapsedCampaign) campaignOpen = true;
    else if (panel.snap !== "full") setSnap(stepSnap(panel.snap, 1));
    else if (task) setSnap("peek");
    else campaignOpen = false;
  }
  function dockStep(dir: 1 | -1) {
    if (collapsedCampaign) {
      if (dir === 1) campaignOpen = true;
      return;
    }
    if (!task && dir === -1 && panel.snap === "peek") {
      campaignOpen = false;
      return;
    }
    setSnap(stepSnap(panel.snap, dir));
  }

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
    campaignOpen = false;
  });

  // At the lowest docked height a task's comment field is hidden, keeping a
  // draft, so the task box keeps the room; a reply in progress shows it.
  const composerHidden = $derived(
    docked && !!task && panel.snap === "peek" && drag === null && !replyTo,
  );
  let aside = $state<HTMLElement>();
  async function openComposer() {
    setSnap("half");
    await tick();
    aside?.querySelector<HTMLInputElement>(".composerwrap input")?.focus();
  }
  function startReply(c: CommentRow) {
    replyTo = c;
    if (docked && panel.snap === "peek") setSnap("half");
  }
</script>

{#snippet composer()}
  <div class="composerwrap" class:hidden={composerHidden}>
    <CommentComposer
      {task}
      {logins}
      {runner}
      bind:replyTo
      placeholder={composerHint ||
        (task ? "Comment on this task…" : "Comment on the campaign…")}
      {oncomment}
    />
  </div>
{/snippet}

<div
  class="spwrap"
  class:docked
  class:cramped
  class:dragging={drag !== null}
  style={docked
    ? drag !== null
      ? `height: ${drag}px`
      : collapsedCampaign
        ? ""
        : `height: ${SNAP_CSS[panel.snap]}`
    : `width: ${panel.width}px`}
>
  <PanelResizeHandle
    label="Resize the side panel"
    bind:panel
    bind:drag
    {docked}
    {dockLevel}
    dockMin={task ? 1 : 0}
    dockLevels={PANEL_SNAPS.length + 1}
    {dockText}
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
      {#if composerHidden && auth.user}
        <button type="button" class="btn showinline" onclick={openComposer}
          >Comment</button
        >
      {/if}
      {#if collapsedCampaign && (count > 0 || info)}
        <button
          type="button"
          class="btn showinline"
          onclick={() => (campaignOpen = true)}
          >{info ? "Details and comments" : "Comments"} · {count}</button
        >
      {/if}
    </div>
    {#if taskBox}
      <div class="pinhead">{@render taskBox()}</div>
    {:else if emptyLine && !collapsedCampaign}
      <p class="empty">{emptyLine}</p>
    {/if}
    {#if collapsedCampaign}
      <!-- The bar is the campaign's comment field; the list opens above. -->
      {@render composer()}
    {:else}
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
      {@render composer()}
    {/if}
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
  /* Docked below the content: full width, the grip on the top edge. The
     height settles on its snap after a drag. */
  .spwrap.docked {
    flex-direction: column;
    max-width: none;
    width: 100%;
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
    padding: 4px 12px 10px;
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
  /* The shadow fills the panel's bottom padding, so content scrolling under
     the composer does not show below it. With room to spare the composer
     sits at the panel's bottom. */
  .composerwrap {
    flex: none;
    margin-top: auto;
    position: sticky;
    bottom: 0;
    background: var(--bg-inset);
    box-shadow: 0 12px 0 var(--bg-inset);
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
  .clist {
    flex: 1 1 0;
    /* Room for the list heading and a line below it. */
    min-height: 72px;
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
