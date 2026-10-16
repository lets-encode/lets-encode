<!--
  The side panel of every campaign view, always shown. With a task it holds
  the host's task box pinned on top, the task's comments and the composer;
  without one (task '') it holds the campaign comments. Beside the content
  it is resizable by its left edge and the composer follows the comments. In
  portrait up to tablet width (DOCKED_QUERY) it docks below the content at
  its content's height: closed, the header and the task box; opened, the
  comments (without a task, the campaign's details and comments) below them,
  up to DOCKED_MAX_CSS. The header's button, a tap on the top edge or a drag
  of it opens and closes it. Docked or on a touch screen the comment field
  shows only after its button or a Reply is pressed, and closes again when
  left empty. The width persists per browser (side-panels.ts).

  A score workspace (a task's own view) adds its task tools below the task
  box, the selected item's controls in place of the comments, and the task's
  action in a footer pinned to the panel's bottom; a Comments button at the
  task box heading's right end switches between the two. Docked as a sheet
  it shows only the view's bar, the tools (while something is selected, its
  controls below them) and the footer until opened, up to SHEET_PEEK_MAX_CSS; without a
  footer the task box stays in view instead. Dragging a closed sheet down
  lowers it, its content scrolling; dragging a lowered sheet up raises it,
  and dragging it up from its full closed height opens it.
-->
<script module lang="ts">
  // Whether resolved threads are hidden; held for the session across views.
  let hideResolved = $state(false);
  // The height a closed sheet was lowered to, or null for its full closed
  // height; held for the session across views.
  let peekHeight = $state<number | null>(null);
</script>

<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { tick, untrack, type Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { Result } from "$lib/commands.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { buildThreads } from "$lib/campaign-board.ts";
  import {
    DOCKED_MAX_CSS,
    DOCKED_QUERY,
    PANEL_MIN,
    SHEET_PEEK_MAX_CSS,
    clampPanelHeight,
    defaultPanelWidth,
    hasStoredPanelWidth,
    type SidePanelState,
  } from "$lib/side-panels.ts";
  import { markHidden } from "$lib/scroll-edges.ts";
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
    minWidth = PANEL_MIN,
    review = false,
    done = false,
    inScore = false,
    composerHint = "",
    emptyLine = "",
    banner,
    info,
    taskBox,
    tools,
    selection,
    selectionLabel = "Selection",
    selectionActive = false,
    tab = $bindable("selection"),
    compose = 0,
    footer,
    bar,
    sheet = false,
    open = $bindable(false),
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
    /** The narrowest the panel gets beside the content, for a view whose
        tools need more room than PANEL_MIN. */
    minWidth?: number;
    /** Tint the comments in the review colour. */
    review?: boolean;
    /** The task is done: its change requests read as history. */
    done?: boolean;
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
    /** The task's record and controls, pinned above the comments. With a
        selection it is given the Comments button for its heading. */
    taskBox?: Snippet<[Snippet | undefined]>;
    /** The view's task tools, below the task box. */
    tools?: Snippet;
    /** The selected item's controls; with it the panel shows them or the
        comments, by the Comments button in the task box. */
    selection?: Snippet;
    /** The selection tab's name. */
    selectionLabel?: string;
    /** Something is selected: a closed sheet shows the selection's
        controls below the tools. */
    selectionActive?: boolean;
    /** What the panel shows when it has a selection. */
    tab?: "selection" | "comments";
    /** Each change asks for the comment field: the panel opens on the
        comments with the field focused (e.g. "Comment on measure 3"). */
    compose?: number;
    /** The task's action, pinned to the panel's bottom. */
    footer?: Snippet;
    /** Docked as a sheet: a row at the sheet's top, open or closed (e.g. the
        view's page toolbar). */
    bar?: Snippet;
    /** Docked, the panel is a sheet: closed it shows the tools and the
        footer. */
    sheet?: boolean;
    /** Docked: whether the panel is opened past the header and the task box. */
    open?: boolean;
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
  // A new selection scrolls its controls into view when their top is out of
  // the panel's view; a top already in view leaves what is above it (the
  // task box) in view too.
  let selEl = $state<HTMLElement>();
  $effect(() => {
    if (!selectionActive || !selEl || !aside) return;
    const top = selEl.getBoundingClientRect().top;
    const view = aside.getBoundingClientRect();
    if (top < view.top || top > view.bottom - 40)
      selEl.scrollIntoView({ block: "nearest" });
  });
  let fieldOpen = $state(false);
  let draft = $state("");
  // The docked height in pixels while the top edge is dragged.
  let drag = $state<number | null>(null);
  // A drag moves the docked panel's top over the content without resizing
  // the content, which is laid out again once, on release: in the layout the
  // panel keeps its height from before the drag (dragFrom), its top margin
  // taking up the difference.
  let dragFrom = $state(0);
  $effect.pre(() => {
    if (drag === null) dragFrom = 0;
    else if (!untrack(() => dragFrom))
      dragFrom = untrack(() => wrapEl?.getBoundingClientRect().height ?? 0);
  });
  // A drag shows the list it may open, except on a sheet, which keeps its
  // closed content until it is opened; the field only once opened.
  const listShown = $derived(!docked || open || (drag !== null && !sheet));
  // A closed sheet shows the tools and the footer; the task box stays in
  // view only where there is no footer.
  const peek = $derived(sheet && !listShown);
  const taskBoxShown = $derived(!peek || !footer);
  // With a selection the list area shows its controls or the comments.
  const commentsShown = $derived(!selection || tab === "comments");
  let footHeight = $state(0);
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

  // A docked sheet asked to show the comments (the host switching the tab,
  // e.g. "Comment on measure 3") opens.
  let shownTab = tab;
  $effect(() => {
    if (tab === shownTab) return;
    shownTab = tab;
    if (tab === "comments" && sheet && docked) open = true;
  });

  // The comment a reply targets, shared by the thread list and the composer;
  // cleared when the panel changes task.
  let replyTo = $state<CommentRow | null>(null);
  $effect.pre(() => {
    void task;
    replyTo = null;
    open = false;
    fieldOpen = false;
  });

  // What opening the docked panel adds below the header and the task box; a
  // sheet always opens to its task box and tabs.
  const hasMore = $derived(sheet || count > 0 || (!task && !!info));
  const fieldShown = $derived(
    (!docked || open) &&
      commentsShown &&
      (!fieldOnRequest || fieldOpen || !!replyTo),
  );
  const writeShown = $derived(
    (!docked || open) && commentsShown && !fieldShown && !!auth.user,
  );
  const writeLabel = $derived(
    composerHint ? composerHint.replace(/…$/, "") : "Write a comment",
  );
  const toggleLabel = $derived(
    open
      ? "Close"
      : !task && info
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
    tab = "comments";
    fieldOpen = true;
    focusField();
  }
  let composeSeen = untrack(() => compose);
  $effect(() => {
    if (compose === composeSeen) return;
    composeSeen = compose;
    openField();
  });
  function startReply(c: CommentRow) {
    replyTo = c;
    open = true;
    tab = "comments";
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

  // A drag past DOCK_STEP pixels opens or closes the docked panel. A closed
  // sheet takes the height it is dragged down to, at least clampPanelHeight's
  // minimum; dragged up, a lowered sheet takes its new height, back to its
  // full closed height (null) at half the window (SHEET_PEEK_MAX_CSS).
  const DOCK_STEP = 48;
  const lowerTo = (h: number) =>
    (peekHeight = h >= window.innerHeight / 2 ? null : h);
  function dockEnd(height: number, startHeight: number) {
    if (sheet && !open && (height < startHeight || peekHeight !== null))
      lowerTo(height);
    else if (height - startHeight > DOCK_STEP && hasMore) open = true;
    else if (startHeight - height > DOCK_STEP) closePanel();
  }
  function dockTap() {
    if (open) closePanel();
    else if (hasMore) open = true;
  }
  // The arrow keys lower and raise a closed sheet by two steps at a time.
  let wrapEl = $state<HTMLElement>();
  function dockStep(dir: 1 | -1) {
    const h = wrapEl?.getBoundingClientRect().height ?? 0;
    if (sheet && !open && (dir === -1 || peekHeight !== null))
      lowerTo(clampPanelHeight(h + dir * 2 * DOCK_STEP, window.innerHeight));
    else if (dir === 1 && hasMore) open = true;
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

<!-- Switches the list area between the selection's controls and the
     comments; the word gives way to the icon in a narrow heading. -->
{#snippet commentsToggle()}
  <button
    type="button"
    class="tbtn tbtn-icon commentsbtn"
    class:on={tab === "comments"}
    aria-pressed={tab === "comments"}
    aria-label={`Comments, ${count}`}
    title={tab === "comments"
      ? `Show the ${selectionLabel.toLowerCase()} again`
      : "Show the comments on this task"}
    onclick={() => (tab = tab === "comments" ? "selection" : "comments")}
    >{#if posting}<span
        class="spinner"
        role="img"
        title="Processing comment"
        aria-label="Processing comment"
      ></span>{:else}<Icon name="comment" size={16} />{/if}<span
      class="cbtnlabel">Comments</span
    ><span class="cbtncount">{count}</span></button
  >
{/snippet}

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
  bind:this={wrapEl}
  class="spwrap"
  class:docked
  class:sheet={docked && sheet}
  class:cramped
  class:dragging={drag !== null}
  style={docked
    ? drag !== null
      ? `max-height: none; height: ${drag}px; margin-top: ${dragFrom - drag}px`
      : `max-height: ${
          !peek
            ? DOCKED_MAX_CSS
            : peekHeight === null
              ? SHEET_PEEK_MAX_CSS
              : `min(${SHEET_PEEK_MAX_CSS}, ${peekHeight}px)`
        }`
    : `width: ${Math.max(panel.width, minWidth)}px; min-width: ${minWidth}px`}
>
  <PanelResizeHandle
    label="Resize the side panel"
    bind:panel
    min={minWidth}
    bind:drag
    {docked}
    dockLevel={open ? 1 : 0}
    dockMin={0}
    dockLevels={2}
    {dockText}
    dockUp={!open && hasMore}
    dockDown={open || sheet}
    ondockend={dockEnd}
    ondockstep={dockStep}
    ondocktap={dockTap}
  />
  <aside
    bind:this={aside}
    class="sp"
    class:peek
    class:hastask={!!taskBox}
    style={zone ? `--zone: var(--zone-${zone})` : ""}
    aria-label={task ? "Task" : "Campaign"}
    style:--spfoot-h={`${footer ? footHeight : 0}px`}
    {@attach docked && sheet ? markHidden : null}
  >
    {#if docked && sheet}<div class="spedge top" aria-hidden="true"></div>{/if}
    {#if bar && docked && sheet}<div class="spbar">{@render bar()}</div>{/if}
    {@render banner?.()}
    <div class="sphead" class:hidden={peek}>
      {#if ondeselect}
        <button
          type="button"
          class="btn deselect"
          title="Deselect the task and show the campaign comments"
          onclick={ondeselect}><Icon name="arrow-left" /> Campaign</button
        >
        <span class="sep" aria-hidden="true">/</span>
      {/if}
      <!-- In a task's own view the task box's heading names it; the title
           stays for assistive technology. -->
      <h2 class="sptitle" class:vh={!!taskBox && !ondeselect}>
        {task ? "Task" : "Campaign"}
      </h2>
      {#if docked && (hasMore || auth.user)}
        <button
          type="button"
          class="btn showinline"
          aria-expanded={open}
          onpointerdown={() => (openAtPress = open)}
          onclick={toggle}
          >{#if posting}<span
              class="spinner"
              role="img"
              title="Processing comment"
              aria-label="Processing comment"
            ></span>{/if}{toggleLabel}</button
        >
      {/if}
    </div>
    {#if taskBox}
      {#if taskBoxShown}<div class="pinhead">
          {@render taskBox(selection ? commentsToggle : undefined)}
        </div>{/if}
    {:else if emptyLine && listShown}
      <p class="empty">{emptyLine}</p>
    {/if}
    {#if tools}
      <div class="sptools">{@render tools()}</div>
    {/if}
    {#if peek && selection && selectionActive}
      <div class="spsel">{@render selection()}</div>
    {/if}
    {#if selection && listShown && tab === "selection"}
      <div
        class="spsel"
        role="region"
        aria-label={selectionLabel}
        bind:this={selEl}
      >
        {@render selection()}
      </div>
    {/if}
    <!-- A task's empty list in a docked or short panel is left out, so it
         adds no gap above the composer. -->
    {#if listShown && commentsShown && !(task && cramped && count === 0)}
      <div class="clist">
        {#if !task}{@render info?.()}{/if}
        <!-- In a docked or short panel, no comments means no list: the
             composer sits right under the task box. -->
        {#if !(cramped && count === 0 && (task || !info))}
          <!-- Below the tabs the heading only carries the resolved filter. -->
          <div
            class="sechead"
            class:review
            class:hidden={!!selection && resolvedCount === 0}
          >
            {#if !selection}
              <span class="secdot"></span>
              {task ? "Comments" : "Campaign comments"}
              <span class="seccount">{count}</span>
            {/if}
            {#if resolvedCount > 0}
              <button
                type="button"
                class="chip-switch"
                class:on={hideResolved}
                aria-pressed={hideResolved}
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
              settled={done}
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
    {#if docked && sheet && !footer}
      <div class="spedge bottom" aria-hidden="true"></div>
    {/if}
    {#if footer}
      <div class="spfoot" bind:offsetHeight={footHeight}>
        {@render footer()}
      </div>
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
  /* Docked below the content: full width, the grip on the top edge, as tall
     as its content up to its inline max-height. After a drag the height
     returns to its content's, animated where height: auto interpolates; the
     max-height of a closed sheet animates with it, except from a drag, which
     has none. While dragged the panel lies over the content. */
  .spwrap.docked {
    flex: none;
    flex-direction: column;
    max-width: none;
    width: 100%;
    interpolate-size: allow-keywords;
    transition:
      height 200ms cubic-bezier(0.22, 1, 0.36, 1),
      max-height 200ms cubic-bezier(0.22, 1, 0.36, 1);
    border-top: 1px solid var(--line-strong);
    box-shadow: 0 -2px 8px var(--shade);
    background: var(--card);
  }
  .spwrap.docked.dragging {
    position: relative;
    z-index: 3;
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .spwrap.docked {
      transition: none;
    }
  }
  /* One raised sheet. Its sections are told apart by tone, with a hairline
     between them: the task's heading in the stage's wash, the view's bar
     and tools on paper, the selected item's controls, the comments and the
     footer on slate, the selected item's section closed by a hairline below
     as well. Buttons on the tinted sections sit on paper (--btn-bg). */
  .sp {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-sm);
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .docked .sp {
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .sp > :global(*) {
    flex: none;
  }
  .sp :global(.banner) {
    margin: 0;
  }
  .sphead,
  .spsel,
  .clist,
  .composerwrap,
  .empty,
  .spfoot {
    --btn-bg: var(--card);
    --btn-shadow: 0 1px 2px rgba(31, 36, 51, 0.1);
    --btn-bg-hover: color-mix(in srgb, var(--ink) 5%, var(--card));
  }
  .sphead {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 10px 16px 0;
  }
  .hastask .sphead {
    background: var(--st-wash);
  }
  /* Without a task the campaign's comments fill the sheet, on slate. */
  .sp:not(.hastask) {
    background: var(--band);
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
    bottom: var(--spfoot-h, 0px);
    background: var(--band);
    padding: 6px 16px 12px;
  }
  /* Right below the task box or the selection the composer starts its own
     section; below the comments it continues theirs. */
  .sp > :not(.clist):not(.composerwrap) + .composerwrap {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .composerwrap.hidden,
  .sphead.hidden,
  .sechead.hidden {
    display: none;
  }
  /* A score workspace's tools and selection controls keep their height;
     the footer stays at the panel's bottom, the composer above it. */
  .sptools {
    padding: 12px 16px;
    background: var(--card);
    border-top: 1px solid var(--line);
  }
  /* The Comments button, 32px with a 44px press through an invisible
     ::after; its word gives way to the icon below 320px of task heading
     (TaskBox's taskhead container). */
  .commentsbtn {
    flex: none;
    position: relative;
    box-sizing: border-box;
    min-width: 32px;
    min-height: 32px;
    justify-content: center;
    gap: 5px;
  }
  .commentsbtn::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
  .cbtnlabel,
  .cbtncount {
    font: 600 12px var(--font);
    line-height: 1;
  }
  .cbtncount {
    font-variant-numeric: tabular-nums;
  }
  @container taskhead (max-width: 319px) {
    .cbtnlabel {
      display: none;
    }
  }
  /* The selection's controls keep their full height; where the panel is
     too short the panel scrolls as a whole, and a new selection scrolls
     them into view above the footer. */
  .spsel {
    padding: 14px 16px;
    background: var(--band);
    border-top: 1px solid var(--line);
    box-shadow: 0 1px 0 var(--line);
    scroll-margin-bottom: calc(var(--spfoot-h, 0px) + 12px);
  }
  /* The footer closes the sheet; a short list leaves room above it. */
  .spfoot {
    margin-top: auto;
    position: sticky;
    bottom: 0;
    z-index: 1;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
    background: var(--band);
  }
  /* The view's bar measures its own width (container queries). */
  .spbar {
    container-type: inline-size;
    padding: 6px 12px 8px;
    background: var(--card);
  }
  /* A sheet's first section takes the top padding the grip leaves. */
  .sheet .sp > .spbar:first-of-type {
    padding-top: 2px;
  }
  /* A sheet's rounded top edge; its footer clears the home indicator. */
  .spwrap.sheet {
    border-radius: 14px 14px 0 0;
  }
  .sheet .spfoot {
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }
  .sheet .sp {
    /* A field focused near either edge scrolls clear of the fades. */
    scroll-padding-top: 26px;
    scroll-padding-bottom: calc(var(--spfoot-h, 0px) + 26px);
  }
  /* A sheet fades out at its top, and above the composer or else the
     footer, while there is more to scroll to in that direction
     (scroll-edges.ts). The edges are zero-height sticky rows; the flex gap
     around them is taken back by a negative margin. */
  .spedge {
    flex: none;
    position: sticky;
    z-index: 2;
    height: 0;
  }
  .spedge.top {
    top: 0;
  }
  .spedge.bottom {
    bottom: 0;
  }
  .spedge::after,
  .sheet .composerwrap::before,
  .sheet .spfoot::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 26px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
  }
  /* The top fade covers the panel's top padding too. */
  .spedge.top::after {
    top: 0;
    background: linear-gradient(var(--card), transparent);
  }
  .sheet .composerwrap::before,
  .sheet .spfoot::before {
    bottom: 100%;
    background: linear-gradient(transparent, var(--band));
  }
  /* Without a footer the bottom fade runs down over the panel's bottom
     padding. */
  .spedge.bottom::after {
    top: -26px;
    height: auto;
    bottom: calc(-1 * env(safe-area-inset-bottom));
    background: linear-gradient(transparent, var(--band) 26px);
  }
  .spwrap:global([data-more-above]) .spedge.top::after,
  .spwrap:global([data-more-below]) .spedge.bottom::after,
  .spwrap:global([data-more-below]) .composerwrap::before,
  .spwrap:global([data-more-below]) .spfoot::before {
    opacity: 1;
  }
  .composerwrap:not(.hidden) ~ .spedge::after,
  .composerwrap:not(.hidden) ~ .spfoot::before {
    display: none;
  }
  /* Docked or in a short window the list is no scroll area of its own: the
     panel scrolls as one, the comments right below the task box. */
  .cramped .sp > .clist {
    flex: none;
    min-height: 0;
    overflow-y: visible;
  }
  .sphead :global(.btn) {
    padding: 4px 12px;
  }
  .empty {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-soft);
    padding: 12px 16px;
    background: var(--band);
    border-top: 1px solid var(--line);
  }
  .showinline {
    margin-left: auto;
    flex: none;
  }
  /* Docked, the header's buttons and the comment button take a 44px press
     through an invisible ::after. */
  .docked .sphead :global(.btn),
  .docked .writebtn {
    position: relative;
  }
  .docked .sphead :global(.btn)::after,
  .docked .writebtn::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
  .writebtn {
    width: 100%;
    min-height: 32px;
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
  .sp > .clist {
    flex: 0 1 auto;
    /* Room for the list heading and a line below it. */
    min-height: 50px;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px 6px;
    background: var(--band);
    border-top: 1px solid var(--line);
  }
  .sechead {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-soft);
    padding: 4px 2px 0;
    display: flex;
    flex-wrap: wrap;
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
