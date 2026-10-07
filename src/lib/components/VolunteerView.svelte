<!--
  The campaign page for viewers without push access: the viewer's next task
  as the one action card, every other open task as a list filtered by kind,
  and every piece as a table row that expands to its tasks. Rows only
  navigate — the actions live on the next-task card and the side panel.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { login } from "$lib/auth.svelte.ts";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import {
    clipTitle,
    findRow,
    pieceLabel,
    pieceZone,
  } from "$lib/campaign-tables.ts";
  import type { LockRow, PieceRef, TaskRow } from "$lib/campaign-tables.ts";
  import { cardName, cardPill, doneLabel } from "$lib/campaign-board.ts";
  import { pageOfLocator, claimLabel, workPlace } from "$lib/campaign-graph.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import { piecePreview } from "$lib/piece-previews.ts";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { PagePreview, PiecePreview } from "$lib/piece-previews.ts";

  let {
    owner,
    repo,
    cards,
    nextCard,
    completedTask,
    taskDefs,
    locks,
    viewer,
    pieces,
    progress,
    pieceIndex,
    busy,
    shownTask,
    expandedPiece = $bindable(null),
    onact,
    onopen,
  }: {
    owner: string;
    repo: string;
    /** Every board card, in column order. */
    cards: BoardCard[];
    /** The first card the viewer can act on, or null. */
    nextCard: BoardCard | null;
    /** The task mei-friend just reported complete, shown in the next task's
        place while set; null otherwise. */
    completedTask: string | null;
    taskDefs: TaskRow[];
    locks: LockRow[];
    viewer: string;
    pieces: PieceRef[];
    /** Fragment path → tasks done / tasks total, for the piece rows. */
    progress: Map<string, { done: number; total: number }>;
    /** Task id → index into `pieces`, for grouping and tinting by piece. */
    pieceIndex: Map<string, number>;
    busy: boolean;
    /** The task the side panel shows, or null. */
    shownTask: string | null;
    /** The piece row expanded to its task list. */
    expandedPiece?: string | null;
    /** Perform a card's action (claim, or open its detail). */
    onact: (card: BoardCard) => void;
    /** Open a task's panel. */
    onopen: (task: string) => void;
  } = $props();

  const completedCard = $derived(
    completedTask
      ? (cards.find((c) => c.task === completedTask) ?? null)
      : null,
  );
  /** The card at the top: the task just completed, else the next task. */
  const featured = $derived(completedCard ?? nextCard);

  const mine = (c: BoardCard) =>
    viewer !== "" &&
    locks.some((l) => l.task_id === c.task && l.user_id === viewer);
  /** Tasks the viewer can pick up now: open ones, and reviews with a slot
      they may claim. Logged out, every open task and free review slot. */
  const openCards = $derived(
    cards.filter(
      (c) =>
        c.task !== featured?.task &&
        !mine(c) &&
        (viewer === ""
          ? c.column === "ready" ||
            (c.column === "validation" && c.slots.some((s) => s.key === "open"))
          : (c.column === "ready" && c.claimable) ||
            (c.column === "validation" && c.slots.some((s) => s.claimable))),
    ),
  );
  /** The viewer's own submissions waiting for another volunteer's review. */
  const waitingCards = $derived(
    cards.filter((c) => c.column === "validation" && c.submittedByViewer),
  );

  /** Tasks other than the next-task card (which shows its own) with a
      submission still being processed. */
  const running = $derived(
    cards.filter(
      (c) => c.task !== featured?.task && pendingVerdicts.forTask(c.task),
    ),
  );

  // The kind filters over the open-task list; a card's kind is the stage its
  // claim starts.
  type Kind = "enc" | "review" | "pre";
  const kindOf = (c: BoardCard): Kind =>
    c.column === "validation" ? "review" : c.pre ? "pre" : "enc";
  const KINDS: { key: Kind; label: string }[] = [
    { key: "enc", label: "Encoding" },
    { key: "review", label: "Review" },
    { key: "pre", label: "Preparation" },
  ];
  let kinds = $state<Record<Kind, boolean>>({
    enc: true,
    review: true,
    pre: true,
  });
  const listed = $derived(openCards.filter((c) => kinds[kindOf(c)]));
  /** Kinds present among the open tasks; the filters show only for those. */
  const presentKinds = $derived(new Set(openCards.map(kindOf)));

  const tintOf = (i: number) => `--piece-tint: var(--zone-${pieceZone(i)})`;
  // A single-piece campaign keeps its one piece expanded.
  const lone = $derived(pieces.length === 1);

  const actLabel = (c: BoardCard): string => {
    if (viewer === "") return "Log in to claim";
    if (c.column === "ready") return claimLabel(c.locator);
    if (c.column === "validation" && c.slots.some((s) => s.claimable))
      return "Claim to review";
    return "Open task";
  };
  // What the card's button does, for its tooltip.
  const actTitle = (c: BoardCard): string => {
    if (viewer === "") return "Log in with GitHub to claim this task.";
    if (c.column === "validation") return "Takes a review slot on this task.";
    if (c.pre)
      return `Claims this task for you and opens the ${workPlace(c.locator)}.`;
    return "Claims this task for you and opens the score in mei-friend.";
  };

  // The stage a claim starts, as the button's colour class.
  const stageClass = (c: BoardCard) =>
    c.column === "validation" ? "btn-review" : c.pre ? "btn-pre" : "btn-enc";

  // The stage beside a task's name where the name does not say it.
  const typeOf = (c: BoardCard) => (c.column === "validation" ? "review" : "");

  const startPage = (c: BoardCard): number | null => pageOfLocator(c.locator);

  // First-page thumbnails, page crops and measure counts, loaded per piece.
  let previews = $state<Record<string, PiecePreview>>({});
  $effect(() => {
    const f = readForge();
    for (const piece of pieces) {
      const path = piece.path;
      if (previews[path]) continue;
      piecePreview(f, owner, repo, path).then((preview) => {
        previews[path] = preview;
      });
    }
  });

  const nextPiece = $derived(
    featured ? pieces[pieceIndex.get(featured.task) ?? 0] : undefined,
  );
  const nextPreview = $derived(
    nextPiece ? previews[nextPiece.path] : undefined,
  );
  const nextPage = $derived(featured ? startPage(featured) : null);
  /** The next task's own page, when the piece has facsimile pages. */
  const nextPagePreview = $derived<PagePreview | undefined>(
    nextPreview?.pages[(nextPage ?? 1) - 1],
  );

  // The next-task card's context line: a review's stage (the title names the
  // task and page); for an open encoding from an OMR draft, what the draft
  // is; for a preparation task, the piece's pages; the
  // page's size; and for an encoding section whose preceding section is
  // done, where it picks up.
  const nextContext = $derived.by(() => {
    if (!featured) return "";
    const parts = typeOf(featured) ? [typeOf(featured)] : [];
    if (featured.column === "ready" && featured.omr)
      parts.push("starts from an OMR draft (optical music recognition)");
    const pageCount = nextPreview?.pages.length ?? 0;
    if (featured.pre && pageCount)
      parts.push(`${pageCount} page${pageCount === 1 ? "" : "s"}`);
    const measures = nextPage
      ? (nextPreview?.pageMeasures[nextPage - 1] ?? 0)
      : 0;
    if (measures) {
      const staves = nextPreview?.staves ?? 0;
      parts.push(
        `≈ ${measures} measures${staves ? `, ${staves} ${staves === 1 ? "staff" : "staves"}` : ""}`,
      );
    }
    const dep = findRow(taskDefs, featured.task, "")?.depends_on;
    const depCard = dep ? cards.find((c) => c.task === dep) : undefined;
    if (
      featured.column === "ready" &&
      !featured.pre &&
      depCard?.column === "done" &&
      !depCard.pre
    )
      parts.push("continues where the previous task ended");
    return parts.join(" · ");
  });

  // The crop box's width on screen, for placing the page image so that the
  // page's measures span it, read from their top: the box shows the first
  // systems of the task's page.
  let cropW = $state(0);
  const cropStyle = $derived.by(() => {
    const page = nextPagePreview;
    if (!page?.box || !page.width || !cropW) return "";
    const bw = page.box.lrx - page.box.ulx;
    if (bw <= 0) return "";
    const scale = cropW / bw;
    return `width:${page.width * scale}px;transform:translate(${-page.box.ulx * scale}px,${-page.box.uly * scale}px)`;
  });

  // The expanded piece's tasks: actionable ones first, then blocked, then
  // merged, keeping the board order within each group.
  const groupOrder: Record<string, number> = {
    ready: 0,
    encoding: 0,
    validation: 0,
    blocked: 1,
    done: 2,
  };
  const pieceTasks = (index: number) =>
    cards
      .filter((c) => (pieceIndex.get(c.task) ?? 0) === index)
      .toSorted((a, b) => groupOrder[a.column] - groupOrder[b.column]);
  // A piece's open work by stage: preparation and encoding tasks open to
  // claim, and reviews with a free slot.
  const stageCounts = (index: number) => {
    const counts = { pre: 0, enc: 0, review: 0 };
    for (const c of pieceTasks(index)) {
      if (c.column === "ready") counts[c.pre ? "pre" : "enc"]++;
      else if (c.column === "validation" && c.slots.some((s) => s.claimable))
        counts.review++;
    }
    return counts;
  };
  // Tasks in validation, for the piece bar's review segment.
  const reviewing = (index: number) =>
    pieceTasks(index).filter((c) => c.column === "validation").length;

  function toggle(path: string) {
    expandedPiece = expandedPiece === path ? null : path;
  }
</script>

{#snippet thumb(path: string)}
  {@const url = previews[path]?.thumb}
  <span class="paper">
    {#if url}
      <img src={url} alt="" loading="lazy" />
    {/if}
  </span>
{/snippet}

{#snippet chips(card: BoardCard)}
  {#if card.counts.fails > 0}
    <span class="chip chip-fail"
      >{card.counts.fails} change request{card.counts.fails === 1
        ? ""
        : "s"}</span
    >
  {/if}
  {#if card.counts.comments > 0}
    <span class="chip chip-note"
      >{card.counts.comments} comment{card.counts.comments === 1
        ? ""
        : "s"}</span
    >
  {/if}
{/snippet}

<div class="volunteer">
  <div class="vcol">
    {#if featured}
      <div class="vsec">
        <h2 class="vh">
          {completedCard ? "Just completed" : "Your next task"}
        </h2>
        <!-- The title button's hit area covers the card; the action buttons
             sit above it. The badge on its top edge names the card, as the
             board's "next task" badge does. -->
        <div class="nextcard stage-{kindOf(featured)}">
          <span
            class="nextbadge"
            class:done={!!completedCard}
            aria-hidden="true"
            >{completedCard ? "just completed" : "your next task"}</span
          >
          <!-- The task's own page, cropped to its measures; a page without
               zones shows from its top; a piece without pages shows its
               opening system. -->
          <div class="crop" bind:clientWidth={cropW}>
            {#if nextPagePreview?.url}
              <img
                src={nextPagePreview.url}
                alt=""
                class:whole={!cropStyle}
                style={cropStyle}
              />
            {:else if nextPreview?.incipit}
              <div class="incipit">{@html nextPreview.incipit}</div>
            {/if}
            {#if nextPage}
              <span class="croplabel">p. {nextPage}</span>
            {/if}
          </div>
          <div class="nextbody">
            <button
              type="button"
              class="nexttitle"
              onclick={() => onopen(featured.task)}
              title="Open this task"
              >{featured.description}{#if featured.scope}<span class="scope"
                  >{` · ${featured.scope}`}</span
                >{/if}</button
            >
            <span class="nextpiece" title={featured.piece}
              >{clipTitle(featured.piece)}</span
            >
            <span class="nextcontext">{nextContext}</span>
            <TaskRunState task={featured.task} large />
            <!-- A card whose action only opens the task leaves it to the task's
                 panel while that shows it. -->
            {#if !completedCard && !(featured.task === shownTask && actLabel(featured) === "Open task")}
              <div class="nextacts">
                <button
                  type="button"
                  class="btn btn-lg btn-primary {stageClass(featured)}"
                  onclick={() => (viewer === "" ? login() : onact(featured))}
                  disabled={busy ||
                    pendingVerdicts.taskProcessing(featured.task)}
                  title={actTitle(featured)}
                  >{actLabel(
                    featured,
                  )}{#if viewer !== "" && featured.column === "ready" && !featured.pre}<Icon
                      name="external"
                    />{/if}</button
                >
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    {#if openCards.length > 0}
      <div class="vsec">
        <div class="sechead">
          <h2 class="seclabel">
            Open tasks <span class="seccount">{openCards.length}</span>
          </h2>
          {#if presentKinds.size > 1}
            <span class="vspacer"></span>
            {#each KINDS.filter( (k) => presentKinds.has(k.key), ) as kind (kind.key)}
              <button
                type="button"
                class="chip-switch"
                class:on={kinds[kind.key]}
                aria-pressed={kinds[kind.key]}
                onclick={() => (kinds[kind.key] = !kinds[kind.key])}
                title="Show or hide {kind.label.toLowerCase()} tasks in the list"
                ><span class="sw"></span>{kind.label}</button
              >
            {/each}
          {/if}
        </div>
        <div class="tlist">
          {#each listed as card (card.task)}
            {@const index = pieceIndex.get(card.task) ?? 0}
            <div class="trow" style={tintOf(index)}>
              <span class="sdot"></span>
              <span class="stext">
                <button
                  type="button"
                  class="stitle"
                  onclick={() => onopen(card.task)}
                  title="Open this task"
                  >{card.description}{#if card.scope}<span class="scope"
                      >{` · ${card.scope}`}</span
                    >{/if}</button
                >
                {#if !lone}
                  <span class="spiece" title={card.piece}
                    >{clipTitle(card.piece)}</span
                  >
                {/if}
              </span>
              <span class="stype">{typeOf(card)}</span>
              <span class="vspacer"></span>
              {@render chips(card)}
            </div>
          {:else}
            <span class="none">No open tasks of these kinds.</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if waitingCards.length > 0}
      <div class="vsec">
        <h2 class="seclabel">
          Waiting for review <span class="seccount">{waitingCards.length}</span>
        </h2>
        <div class="tlist">
          {#each waitingCards as card (card.task)}
            <div class="trow" style={tintOf(pieceIndex.get(card.task) ?? 0)}>
              <span class="sdot"></span>
              <span class="stext">
                <button
                  type="button"
                  class="stitle"
                  onclick={() => onopen(card.task)}
                  title="Open this task"
                  >{card.description}{#if card.scope}<span class="scope"
                      >{` · ${card.scope}`}</span
                    >{/if}</button
                >
                {#if !lone}
                  <span class="spiece" title={card.piece}
                    >{clipTitle(card.piece)}</span
                  >
                {/if}
              </span>
              <span class="vspacer"></span>
              <span
                class="taskpill"
                title="You submitted it; another volunteer needs to review it."
                >waiting for review</span
              >
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if running.length > 0}
      <div class="vsec">
        <h2 class="seclabel">Being processed</h2>
        {#each running as card (card.task)}
          <div class="runcard">
            <span class="runtitle">{card.title}</span>
            <TaskRunState task={card.task} large />
          </div>
        {/each}
      </div>
    {/if}

    {#if !featured && openCards.length === 0}
      <span class="none"
        >{waitingCards.length > 0
          ? "No tasks are open for you right now."
          : "No tasks are open right now: every task is claimed, in review, waiting for an earlier task, or done."}</span
      >
    {/if}

    {#if pieces.length > 0}
      <div class="vsec">
        <h2 class="seclabel">Pieces</h2>
        <div class="ptable">
          {#each pieces as piece, index (piece.path)}
            {@const p = progress.get(piece.path)}
            {@const open = lone || expandedPiece === piece.path}
            {@const counts = stageCounts(index)}
            {@const review = reviewing(index)}
            <div class="piece" style={tintOf(index)}>
              <div class="prow">
                {@render thumb(piece.path)}
                {#if lone}
                  <span class="piecename" title={pieceLabel(piece)}
                    >{clipTitle(pieceLabel(piece))}</span
                  >
                {:else}
                  <button
                    type="button"
                    class="piecename"
                    aria-expanded={open}
                    onclick={() => toggle(piece.path)}
                    title={`${pieceLabel(piece)} · ${open ? "Collapse this piece" : "Show this piece's tasks"}`}
                    >{clipTitle(pieceLabel(piece))}</button
                  >
                {/if}
                <!-- Done, in review and the rest, in the stage colours; a lone
                     piece leaves its progress to the page header. -->
                {#if !lone}
                  <div
                    class="segbar"
                    role="img"
                    aria-label={`${p?.done ?? 0} done, ${review} in review, ${(p?.total ?? 0) - (p?.done ?? 0) - review} to do`}
                    title={`${p?.done ?? 0} done, ${review} in review, ${(p?.total ?? 0) - (p?.done ?? 0) - review} to do`}
                  >
                    {#if p?.done}
                      <div class="seg done" style="flex: {p.done}"></div>
                    {/if}
                    {#if review}
                      <div class="seg review" style="flex: {review}"></div>
                    {/if}
                    {#if p && p.total - p.done - review > 0}
                      <div
                        class="seg"
                        style="flex: {p.total - p.done - review}"
                      ></div>
                    {/if}
                  </div>
                  {#if p && p.total > 0 && p.done === p.total}
                    <span class="piecedone complete"
                      ><Icon name="check" size={12} /> done</span
                    >
                  {:else}
                    <span class="piecedone"
                      >{p?.done ?? 0} of {p?.total ?? 0} done</span
                    >
                  {/if}
                {/if}
                {#if counts.enc > 0}
                  <span class="scount enc">{counts.enc} open</span>
                {/if}
                {#if counts.review > 0}
                  <span class="scount review"
                    >{counts.review} review{counts.review === 1
                      ? ""
                      : "s"}</span
                  >
                {/if}
                {#if counts.pre > 0}
                  <span class="scount pre">{counts.pre} preparation</span>
                {/if}
                <span class="vspacer"></span>
                {#if !lone}
                  <span class="pchev"
                    ><Icon
                      name={open ? "chevron-down" : "chevron-right"}
                    /></span
                  >
                {/if}
              </div>
              {#if open}
                <div class="piecetasks">
                  {#each pieceTasks(index) as card (card.task)}
                    {#if card.column === "blocked"}
                      <div class="taskrow still">
                        <span class="tasktitle">{cardName(card)}</span>
                        <span class="ttype">{typeOf(card)}</span>
                        <TaskRunState task={card.task} />
                        <span class="vspacer"></span>
                        <span class="waits">waits for {card.waitsFor}</span>
                      </div>
                    {:else if card.column === "done"}
                      <div class="taskrow">
                        <button
                          type="button"
                          class="tasktitle"
                          onclick={() => onopen(card.task)}
                          title="Open this task">{cardName(card)}</button
                        >
                        <span class="ttype">{typeOf(card)}</span>
                        <TaskRunState task={card.task} />
                        <span class="vspacer"></span>
                        {@render chips(card)}
                        <span class="merged"
                          ><Icon name="check" size={12} />
                          {doneLabel(card)}</span
                        >
                        <span class="tchev"><Icon name="chevron-right" /></span>
                      </div>
                    {:else}
                      <div class="taskrow">
                        <button
                          type="button"
                          class="tasktitle"
                          onclick={() => onopen(card.task)}
                          title="Open this task">{cardName(card)}</button
                        >
                        <span class="ttype">{typeOf(card)}</span>
                        <TaskRunState task={card.task} />
                        <span class="vspacer"></span>
                        {@render chips(card)}
                        {#if card.task === completedCard?.task}
                          <span class="taskpill next">just completed</span>
                        {:else if card.nextUp && !completedCard && !lone}
                          <span class="taskpill next">your next task</span>
                        {:else if card.column === "validation" && card.submittedByViewer}
                          <span
                            class="taskpill"
                            title="You submitted it; another volunteer needs to review it."
                            >waiting for review</span
                          >
                        {:else if card.column === "validation"}
                          <span class="taskpill review">review</span>
                        {:else}
                          <span class="taskpill">{cardPill(card, viewer)}</span>
                        {/if}
                        <span class="tchev"><Icon name="chevron-right" /></span>
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .volunteer {
    /* The column takes what the host's group leaves beside the side panel
       and scrolls on its own. It is the container for the narrow layout
       below. */
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    container-type: inline-size;
    min-height: 0;
    overflow-y: auto;
    /* Room for the scrollbar beside the content, not over its right edge. */
    scrollbar-gutter: stable;
    padding-right: 10px;
    box-sizing: border-box;
  }
  .vcol {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 8px;
  }
  .vspacer {
    flex: 1;
  }

  .vsec {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sechead {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .seclabel {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .seccount {
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-tint);
    border-radius: 999px;
    line-height: 1;
    padding: 3px 7px;
    letter-spacing: 0;
  }

  /* A row's title button reaches over the whole row; the row's other buttons
     and pills sit above it. The focus ring is drawn on the row. */
  :where(.nexttitle, .stitle, button.piecename, .tasktitle) {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .nexttitle::after,
  .stitle::after,
  button.piecename::after,
  .tasktitle::after {
    content: "";
    position: absolute;
    inset: 0;
  }
  .nexttitle:focus-visible,
  .stitle:focus-visible,
  button.piecename:focus-visible,
  .tasktitle:focus-visible {
    outline: none;
  }
  .nextcard:has(.nexttitle:focus-visible),
  .trow:has(.stitle:focus-visible),
  .prow:has(.piecename:focus-visible),
  .taskrow:has(.tasktitle:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .nextcard .btn,
  .scount {
    position: relative;
    z-index: 1;
  }

  /* ------------------------------------------------------- next-task card */
  .nextbadge {
    position: absolute;
    top: -9px;
    left: 18px;
    z-index: 1;
    background: var(--accent);
    color: var(--invert-ink);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.03em;
    line-height: 1;
    padding: 4px 10px;
    border-radius: 999px;
    white-space: nowrap;
  }
  /* The badge and the border take the stage of the task: encoding blue,
     preparation purple, review orange. */
  .nextcard.stage-pre {
    border-color: color-mix(in srgb, var(--pre) 45%, var(--line));
  }
  .nextcard.stage-pre:hover {
    border-color: var(--pre);
  }
  .nextcard.stage-review {
    border-color: var(--warn-line);
  }
  .nextcard.stage-review:hover {
    border-color: var(--warn);
  }
  .stage-pre .nextbadge,
  .stage-review .nextbadge {
    color: #fff;
  }
  .stage-pre .nextbadge {
    background: var(--pre-solid);
  }
  .stage-review .nextbadge {
    background: var(--warn-solid);
  }
  .nextbadge.done {
    background: var(--ok);
  }
  :global([data-theme="dark"]) .nextbadge.done {
    color: #fff;
  }
  .nextcard {
    position: relative;
    margin-top: 9px;
    display: flex;
    align-items: center;
    gap: 18px;
    background: var(--card);
    border: 1.5px solid var(--info-line);
    border-radius: 14px;
    padding: 18px 22px;
    box-shadow: var(--shadow-md);
    transition: border-color 0.15s ease;
  }
  .nextcard:hover {
    border-color: var(--accent);
  }
  .runcard {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 14px 22px;
    background: var(--card);
    border: 1.5px solid var(--info-line);
    border-radius: 14px;
    box-shadow: var(--shadow-md);
  }
  .runcard + .runcard {
    margin-top: 8px;
  }
  .runtitle {
    font-size: 15px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  /* The crop grows with the card, keeping its proportions. */
  .crop {
    position: relative;
    flex: none;
    width: clamp(260px, 36%, 480px);
    aspect-ratio: 260 / 144;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    background: var(--facsimile-paper);
    box-shadow:
      4px 4px 0 var(--mat),
      var(--shadow-md);
  }
  .crop img {
    display: block;
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }
  /* A page without a measure box: the band a third down the page, below the
     title block. */
  .crop img.whole {
    position: static;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 33%;
  }
  .incipit {
    height: 100%;
    display: flex;
    align-items: center;
    padding: 8px;
    box-sizing: border-box;
  }
  .incipit :global(svg) {
    width: 100%;
    height: auto;
    max-height: 100%;
  }
  .croplabel {
    position: absolute;
    left: 8px;
    bottom: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid var(--line);
    border-radius: 999px;
    line-height: 1;
    padding: 3px 8px;
  }
  .nextbody {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    flex: 1;
  }
  .nexttitle {
    font-size: 19px;
    line-height: 1.2;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .scope {
    color: var(--ink-soft);
  }
  /* The task's piece under its name. A long title is cut: two lines here,
     one in the list rows; the full title is the tooltip. */
  .nextpiece {
    font-size: 13px;
    color: var(--ink-soft);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .nextcontext {
    font-size: 13px;
    color: var(--ink-soft);
  }
  /* The action sits under the text it acts on. */
  .nextacts {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
    margin-top: 6px;
  }

  /* ------------------------------------------------------- open-task list */
  .tlist {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .trow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 12px;
    transition: background-color 0.15s ease;
  }
  .trow + .trow {
    border-top: 1px solid var(--line);
  }
  .trow:hover {
    background: var(--accent-tint);
  }
  .sdot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--piece-tint);
  }
  .stext {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .stitle {
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
    text-align: left;
  }
  .spiece {
    font-size: 11.5px;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stype {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .trow .chip,
  .taskrow .chip {
    padding: 2px 8px;
  }
  .tlist .none {
    display: block;
    padding: 10px 12px;
  }

  .none {
    font-size: 12px;
    color: var(--ink-faint);
  }

  /* --------------------------------------------------------- pieces table */
  .ptable {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .piece + .piece {
    border-top: 1px solid var(--line);
  }
  .prow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    background: color-mix(in srgb, var(--piece-tint) 6%, var(--card));
    padding: 9px 12px;
  }
  .paper {
    flex: none;
    width: 32px;
    height: 42px;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
    box-sizing: border-box;
    box-shadow: var(--shadow-sm);
  }
  .paper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .piecename {
    font-size: 13px;
    font-weight: 600;
    flex: none;
    width: 230px;
    overflow-wrap: anywhere;
    text-align: left;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .segbar {
    flex: none;
    display: flex;
    gap: 2px;
    width: 120px;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    overflow: hidden;
  }
  .seg.done {
    background: var(--green);
  }
  .seg.review {
    background: var(--warn-line);
  }
  .piecedone {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
    width: 78px;
  }
  .piecedone.complete {
    color: var(--ok);
    font-weight: 600;
  }
  /* Open work per stage, in the stage colours. */
  .scount {
    font-size: 11px;
    font-weight: 600;
    border-radius: 999px;
    line-height: 1;
    padding: 3px 8px;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .scount.pre {
    color: var(--pre);
    background: var(--pre-wash);
    border-color: var(--pre);
  }
  .scount.review {
    color: var(--warn);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .scount.enc {
    color: var(--info);
    background: var(--info-bg);
    border-color: var(--info-line);
  }
  .pchev {
    font-size: 20px;
    line-height: 1;
    width: 20px;
    text-align: center;
    color: var(--ink-soft);
  }
  .piecetasks {
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid color-mix(in srgb, var(--piece-tint) 25%, var(--line));
  }
  .taskrow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    transition: border-color 0.15s ease;
  }
  .taskrow:not(.still):hover {
    border-color: var(--accent);
  }
  .tasktitle {
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .ttype {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .taskrow.still .tasktitle {
    color: var(--ink-soft);
  }
  .taskpill {
    font-weight: 600;
    font-size: 11px;
    line-height: 1;
    padding: 3px 9px;
    border-radius: 999px;
    white-space: nowrap;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
  }
  .taskpill.next {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .taskpill.review {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .merged {
    font-size: 12px;
    color: var(--ok);
    font-weight: 600;
    white-space: nowrap;
  }
  .waits {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .tchev {
    font-size: 14px;
    color: var(--ink-faint);
  }

  /* Narrow column: the next-task card puts its actions on a full-width line
     under the crop and text, and every row wraps its meta and controls onto
     a second line. */
  @container (max-width: 640px) {
    .nextcard {
      flex-wrap: wrap;
      gap: 14px;
      padding: 14px 16px;
    }
    .crop {
      width: 100%;
      aspect-ratio: auto;
      height: 120px;
    }
    .nextbody {
      flex: 1 1 160px;
    }
    .nextacts {
      align-items: stretch;
    }
    .sechead {
      flex-wrap: wrap;
    }
    .trow,
    .prow,
    .taskrow {
      flex-wrap: wrap;
    }
    .trow .vspacer,
    .prow .vspacer {
      display: none;
    }
    .stitle {
      flex: 1;
    }
    .stype,
    .trow .chip {
      order: 2;
      white-space: normal;
    }
    .stype {
      flex-basis: 100%;
      padding-left: 20px;
    }
    /* The name holds the first line (with the chevron); the bar, count and
       button wrap below it. */
    .piecename {
      flex: 1 0 60%;
      width: auto;
      min-width: 0;
    }
    .pchev {
      order: 1;
    }
    .segbar,
    .piecedone,
    .scount {
      order: 2;
    }
    .segbar {
      flex: 1 1 80px;
    }
    .piecedone {
      width: auto;
    }
    .tasktitle {
      flex-basis: 100%;
    }
    .ttype {
      white-space: normal;
    }
  }
  /* A short window (a phone in landscape): the card drops its crop, so its
     action shows without scrolling. */
  @media (max-height: 500px) {
    .crop {
      display: none;
    }
  }
  /* Phone width: the crop shrinks to a strip of the task's first system. */
  @container (max-width: 420px) {
    .crop {
      height: 96px;
    }
    .nexttitle {
      font-size: 17px;
    }
  }
</style>
