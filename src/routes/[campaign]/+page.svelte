<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { page } from "$app/state";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import {
    CommandRunner,
    readForge,
    viewerId,
    openMeiFriend,
  } from "$lib/command-runner.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import {
    lookupSlug,
    resolveCampaign,
    campaignLoadFailure,
  } from "$lib/campaign-resolve.ts";
  import type { ResolvedCampaign, SlugInfo } from "$lib/campaign-resolve.ts";
  import { isValidHandle } from "$lib/campaign-handle.ts";
  import {
    findRow,
    pieceNamesOf,
    piecePreparationsOf,
    commentAnchor,
    type MeasureAnchor,
    pieceLabel,
    pieceZone,
    clipTitle,
  } from "$lib/campaign-tables.ts";
  import type {
    TaskRow,
    StateRow,
    LockRow,
    HistoryRow,
    CommentRow,
    PieceRef,
  } from "$lib/campaign-tables.ts";
  import { commands, invoke, commentInput } from "$lib/commands.ts";
  import type {
    CommandContext,
    CommentAnchorInput,
    Result,
    FailComment,
  } from "$lib/commands.ts";
  import {
    handle,
    pageOfLocator,
    preTaskHref,
    reviewHref,
  } from "$lib/campaign-graph.ts";
  import {
    buildBoard,
    elapsed,
    expiresIn,
    initialOf,
  } from "$lib/campaign-board.ts";
  import type { BoardCard, ColumnKey } from "$lib/campaign-board.ts";
  import { parseMeiHeader } from "$lib/mei-header.ts";
  import type { MeiHeader } from "$lib/mei-header.ts";
  import {
    DOCKED_QUERY,
    readSidePanel,
    readLastTask,
    writeLastTask,
  } from "$lib/side-panels.ts";
  import { MediaQuery } from "svelte/reactivity";
  import { piecePreview } from "$lib/piece-previews.ts";
  import type { PiecePreview } from "$lib/piece-previews.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import PieceRail from "$lib/components/PieceRail.svelte";
  import PlanEditor from "$lib/components/PlanEditor.svelte";
  import ScoreView from "$lib/components/ScoreView.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import SidePanel from "$lib/components/SidePanel.svelte";
  import TaskBox from "$lib/components/TaskBox.svelte";
  import VolunteerView from "$lib/components/VolunteerView.svelte";

  // The URL carries only the campaign name; the repo it addresses is resolved
  // from it (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  let resolved = $state<ResolvedCampaign | null>(null);
  let resolving = $state(false);
  let notFound = $state(false);
  // The forge lookup of the registry's repo id failed (e.g. rate limit) — the
  // campaign exists but could not be loaded, which is not a "not found".
  let resolveError = $state<string | null>(null);
  // A name that is not (yet) a campaign: held by a setup in progress, reserved
  // for the app's own routes, or blocked. A free name never renders here — it
  // forwards to the wizard.
  let slugState = $state<"pending" | "reserved" | "tombstoned" | null>(null);
  const owner = $derived(resolved?.owner ?? "");
  const repo = $derived(resolved?.repo ?? "");
  const repoId = $derived(resolved?.repoId ?? 0);
  // The acting user's stable numeric id (written to the tables); login is display-only.
  const viewer = $derived(viewerId());

  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notInitialised = $state(false);
  let isPrivate = $state(false);
  let canPush = $state(false);
  // The login the tables were last read as; null when read logged out.
  let readAs: string | null = null;
  let taskDefs = $state<TaskRow[]>([]);
  let rows = $state<StateRow[]>([]);
  let validationColumns = $state<string[]>([]);
  let locks = $state<LockRow[]>([]);
  let history = $state<HistoryRow[]>([]);
  let comments = $state<CommentRow[]>([]);
  let pieces = $state<PieceRef[]>([]);
  // Numeric user id → login, for displaying the people the tables reference.
  let logins = $state<Record<string, string>>({});
  let title = $state("");
  let description = $state("");
  let license = $state("");
  let passThreshold = $state(1);
  let allowSelfValidation = $state(false);

  const runner = new CommandRunner();

  // UI-only state — the board, with the owner's manage takeover and the score
  // view (?score=) over it, and the side panel showing the ?task= task or the
  // campaign. Everything else derives from the tracking tables.
  let manage = $state(false);
  // The side panel's size (side-panels.ts).
  let sidePanel = $state(readSidePanel());
  // The board row's rail takes its wide form only while four lanes fit
  // beside it and the side panel, at the panel's rendered width (its stored
  // width, capped at half the window).
  let instrowBox = $state<DOMRectReadOnly | null>(null);
  const instrowWidth = $derived(instrowBox?.width ?? 0);
  let windowWidth = $state(0);
  // In portrait up to tablet width and in a short window the view is split:
  // the content scrolls as one region and the side panel takes the lower part
  // of the screen (docked) or its right half (a short window).
  const panelOutQuery = new MediaQuery(`${DOCKED_QUERY}, (max-height: 500px)`);
  const panelOut = $derived(panelOutQuery.current);
  /** Four 200px lanes with 1px borders and three 12px gaps. */
  const LANES_WIDTH = 844;
  const ROW_GAP = 14;
  /** The rail's wide width (PieceRail.svelte). */
  const RAIL_WIDE = 168;
  // With the panel outside the board row (panelOut) the row is already
  // narrowed by it.
  const rowBesidePanel = $derived(
    panelOut
      ? instrowWidth
      : instrowWidth - Math.min(sidePanel.width, windowWidth / 2) - ROW_GAP,
  );
  const railChips = $derived(
    instrowWidth > 0 && rowBesidePanel < RAIL_WIDE + ROW_GAP + LANES_WIDTH,
  );
  // The scores a viewer can read end to end: the pieces the tasks address,
  // named from the campaign's config where it names them.
  const previewPieces = $derived.by(() => {
    const paths = [
      ...new Set(
        taskDefs
          .filter((t) => t.subtask_id === "" && t.fragment)
          .map((t) => t.fragment),
      ),
    ];
    return paths.map((path) => {
      const piece = pieces.find((p) => p.path === path);
      return { id: piece?.id ?? path, path, title: piece?.title ?? "" };
    });
  });
  // The stats bar's board filter: every task, or only those someone can act
  // on right now — claimable encodings and validations with a free slot.
  let boardScope = $state<"all" | "open">("all");
  const actionable = (c: BoardCard) =>
    c.column === "ready" ||
    (c.column === "validation" && c.slots.some((s) => s.key === "open"));

  // The score's <meiHead> fields, for the campaign details in the owner's
  // side panel.
  let scoreHead = $state<MeiHeader | null>(null);
  let scoreHeadState = $state<"idle" | "loading" | "done" | "error">("idle");
  async function loadScoreHead() {
    if (scoreHeadState !== "idle") return;
    scoreHeadState = "loading";
    try {
      const f = readForge();
      // The first task's fragment is the piece the campaign opens on.
      const mei = taskDefs[0]?.fragment
        ? await f.getRepoFile(owner, repo, taskDefs[0].fragment)
        : null;
      scoreHead = mei ? parseMeiHeader(mei) : null;
      scoreHeadState = mei ? "done" : "error";
    } catch {
      scoreHeadState = "error";
    }
  }

  $effect(() => {
    if (loaded && canPush) loadScoreHead();
  });

  // Everyone the campaign history records as having acted on the score.
  const workedOn = $derived(
    [...new Set(history.map((h) => h.user_id))].filter(Boolean),
  );

  const graphData = $derived({
    taskDefs,
    rows,
    validationColumns,
    locks,
    passThreshold,
    allowSelfValidation,
  });
  const pieceNames = $derived(pieceNamesOf(pieces));
  const piecePreparations = $derived(piecePreparationsOf(pieces));
  // The clock the board's claim expiries count against, a minute at a time.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  /** When the claim on a held review slot expires. */
  const reviewExpiry = (task: string, sub: string, user: string) => {
    const lock = locks.find(
      (l) =>
        l.task_id === task &&
        l.subtask_id === sub &&
        l.kind === "validation" &&
        l.user_id === user,
    );
    return lock ? expiresIn(lock.expires, now) : "";
  };
  const board = $derived(
    buildBoard(
      graphData,
      comments,
      history,
      viewer,
      logins,
      pieceNames,
      now,
      piecePreparations,
    ),
  );
  const allCards = $derived(board.columns.flatMap((c) => c.cards));
  // Per-piece task progress, for the piece tiles.
  const pieceProgress = $derived.by(() => {
    const by = new Map<string, { done: number; total: number }>();
    for (const card of allCards) {
      const fragment = findRow(taskDefs, card.task, "")?.fragment ?? "";
      if (!fragment) continue;
      const p = by.get(fragment) ?? { done: 0, total: 0 };
      p.total++;
      if (card.column === "done") p.done++;
      by.set(fragment, p);
    }
    return by;
  });
  // Task id → index into previewPieces, for grouping and tinting by piece.
  const pieceIndexByTask = $derived.by(() => {
    const index = new Map(previewPieces.map((p, i) => [p.path, i]));
    const by = new Map<string, number>();
    for (const t of taskDefs)
      if (t.subtask_id === "") by.set(t.task_id, index.get(t.fragment) ?? 0);
    return by;
  });
  // Tasks with unresolved fails or open comments, behind the hero's
  // attention count.
  const attentionCards = $derived(
    allCards.filter(
      (c) => c.column !== "done" && c.counts.fails + c.counts.comments > 0,
    ),
  );
  let showAttention = $state(false);
  // ---------------------------------------------- the instigator piece rail
  // The piece the board is scoped to, or "all" for the full board.
  let selectedPiece = $state<"all" | string>("all");
  const attentionByPiece = $derived.by(() => {
    const by = new Map<string, number>();
    for (const c of attentionCards) {
      const path = previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path;
      if (!path) continue;
      by.set(path, (by.get(path) ?? 0) + c.counts.fails + c.counts.comments);
    }
    return by;
  });
  // Tasks per board category for each piece, shown on its rail row. Ready and
  // blocked share the board's Open column.
  const railCounts = $derived.by(() => {
    const by = new Map<
      string,
      { open: number; encoding: number; validation: number }
    >();
    for (const c of allCards) {
      if (c.column === "done") continue;
      // The Claimable filter counts what the board then shows.
      if (boardScope === "open" && !actionable(c)) continue;
      const path = previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path;
      if (!path) continue;
      const n = by.get(path) ?? { open: 0, encoding: 0, validation: 0 };
      if (c.column === "encoding") n.encoding++;
      else if (c.column === "validation") n.validation++;
      else n.open++;
      by.set(path, n);
    }
    return by;
  });
  // Cards name their piece only while the board shows several pieces.
  const piecesListed = $derived(
    previewPieces.length > 1 && selectedPiece === "all",
  );
  const railPiece = $derived.by(() => {
    const index = previewPieces.findIndex((p) => p.path === selectedPiece);
    return index >= 0 ? { piece: previewPieces[index], index } : null;
  });
  // The scoped piece's preview, for the context strip over the columns.
  let stripPreview = $state<PiecePreview | null>(null);
  $effect(() => {
    const piece = railPiece?.piece;
    stripPreview = null;
    if (!piece || !owner) return;
    const path = piece.path;
    piecePreview(readForge(), owner, repo, path).then((preview) => {
      if (railPiece?.piece.path === path) stripPreview = preview;
    });
  });
  // Tasks the viewer's accepted submissions just moved on this campaign's
  // board, highlighted in their new column for a short while.
  const recentlyFinished = $derived(
    new Set(
      pendingVerdicts.recentlyFinished
        .filter((m) => m.repoId === repoId)
        .map((m) => m.task),
    ),
  );
  const nextCard = $derived(
    board.nextUp
      ? (allCards.find((c) => c.task === board.nextUp) ?? null)
      : null,
  );

  // ------------------------------------------------ the volunteer's header
  // The viewer's own standing in this campaign: tasks they encoded that are
  // done, tasks they hold a claim on, and reviews they hold a slot in.
  const volStanding = $derived.by(() => {
    if (viewer === "") return "";
    const encoded = new Set(
      history
        .filter(
          (h) =>
            h.user_id === viewer &&
            h.action === "submit_encoding" &&
            h.outcome === "accepted",
        )
        .map((h) => h.task_id),
    );
    const done = allCards.filter(
      (c) => c.column === "done" && encoded.has(c.task),
    ).length;
    const claimed = locks.filter(
      (l) => l.user_id === viewer && l.kind !== "validation",
    ).length;
    const reviewing = locks.filter(
      (l) => l.user_id === viewer && l.kind === "validation",
    ).length;
    // A newcomer has nothing to count yet; the line appears with the first.
    if (!done && !claimed && !reviewing) return "";
    const parts = [`${done} done`, `${claimed} claimed`];
    if (reviewing) parts.push(`${reviewing} reviewing`);
    return `You: ${parts.join(" · ")}`;
  });

  // --------------------------------------------------------- the task detail
  // A task's detail opens in the preview panel; the URL carries it as ?task=
  // so the row stays addressable (deep links, post-login resume).
  let detailTask = $state<string | null>(null);
  const detailCard = $derived(
    detailTask ? (allCards.find((c) => c.task === detailTask) ?? null) : null,
  );
  // The lane the narrow board shows (lane tabs): the one picked, else the
  // selected task's, else the next task's.
  let pickedLane = $state<ColumnKey | null>(null);
  const laneOf = (c: BoardCard | null): ColumnKey | null =>
    !c ? null : c.column === "blocked" ? "ready" : c.column;
  // Without a pick, a task or a next task, the first lane holding cards:
  // review, then encoding, then open, then done.
  const firstFilledLane = $derived<ColumnKey>(
    (["validation", "encoding", "ready", "done"] as ColumnKey[]).find((key) =>
      scopedColumns.some((c) => c.key === key && c.cards.length > 0),
    ) ?? "ready",
  );
  const laneTab = $derived<ColumnKey>(
    pickedLane ?? laneOf(detailCard) ?? laneOf(nextCard) ?? firstFilledLane,
  );
  function openTask(task: string) {
    detailTask = task;
    // The lane tabs follow the opened task again.
    pickedLane = null;
    writeLastTask(campaign, task);
    goto(`/${campaign}?task=${encodeURIComponent(task)}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }
  // Deselect the task: the side panel shows the campaign. The score view's
  // parameters stay.
  function closeTask() {
    detailTask = null;
    writeLastTask(campaign, null);
    const query = new URLSearchParams(page.url.searchParams);
    query.delete("task");
    const rest = query.toString();
    goto(`/${campaign}${rest ? `?${rest}` : ""}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }

  // -------------------------------------------------------- the score view
  // The full-page score view is addressed by ?score=<piece path> (and an
  // optional 1-based ?page=), read reactively so back/forward navigate it.
  const scoreView = $derived.by(() => {
    const path = page.url.searchParams.get("score");
    if (!path) return null;
    const index = previewPieces.findIndex((p) => p.path === path);
    return index >= 0 ? { piece: previewPieces[index], index } : null;
  });
  const scoreStartPage = $derived(
    Math.max(0, (Number(page.url.searchParams.get("page")) || 1) - 1),
  );
  // The measure range the score view opens highlighted (from a comment
  // anchor); within the view, anchors work without navigation.
  let anchor = $state<MeasureAnchor | null>(null);
  let scoreViewRef = $state<ReturnType<typeof ScoreView>>();
  // The open task's ?task= survives entering and leaving the score view.
  function openScoreView(
    path: string,
    startPage?: number,
    a: MeasureAnchor | null = null,
  ) {
    anchor = a;
    const query = new URLSearchParams();
    if (detailTask) query.set("task", detailTask);
    query.set("score", path);
    if (startPage) query.set("page", String(startPage + 1));
    // The score already open turns in place; the URL follows without a new
    // history entry.
    const same = scoreView?.piece.path === path;
    if (same) scoreViewRef?.show(startPage, a);
    goto(`/${campaign}?${query}`, {
      noScroll: true,
      keepFocus: true,
      replaceState: same,
    });
  }
  function closeScoreView() {
    goto(
      `/${campaign}${detailTask ? `?task=${encodeURIComponent(detailTask)}` : ""}`,
      { noScroll: true, keepFocus: true },
    );
  }
  function viewScorePiece(index: number, startPage?: number) {
    const path = previewPieces[index]?.path;
    if (path) openScoreView(path, startPage);
  }
  // A task's score view opens at its page when the task covers one surface.
  const cardPage = (card: BoardCard) =>
    String(pageOfLocator(card.locator) ?? "");
  function viewCardScore(card: BoardCard) {
    const page = cardPage(card);
    viewScorePiece(
      pieceIndexByTask.get(card.task) ?? 0,
      page ? Number(page) - 1 : undefined,
    );
  }
  // The header's score button opens the score where the view's attention is:
  // the selected task's pages, else the piece the board is scoped to, else
  // the next task's pages, else the first piece.
  const scoreTarget = $derived(
    detailCard ??
      (railPiece ? null : nextCard) ??
      railPiece?.piece ??
      previewPieces[0] ??
      null,
  );
  const scoreHint = $derived(
    !scoreTarget
      ? ""
      : "task" in scoreTarget
        ? `Opens the score at ${scoreTarget.title}.`
        : `Opens the score of ${pieceLabel(scoreTarget)}.`,
  );
  const canViewScore = $derived(previewPieces.length > 0 && !!scoreTarget);
  function viewContextScore() {
    if (!scoreTarget) return;
    if ("task" in scoreTarget) viewCardScore(scoreTarget);
    else viewScorePiece(previewPieces.indexOf(scoreTarget));
  }
  // A comment anchor outside the score view: open it on the comment's piece,
  // at the anchored page, with the range highlighted.
  function showCommentInScore(c: CommentRow) {
    const path = c.task_id
      ? previewPieces[pieceIndexByTask.get(c.task_id) ?? -1]?.path
      : c.fragment;
    if (!path) return;
    openScoreView(
      path,
      c.page ? Number(c.page) - 1 : undefined,
      commentAnchor(c),
    );
  }

  // The context every command runs against; progress updates feed the busy
  // overlay's step log.
  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo });

  // Read the tracking tables (and privacy/config) for the console. Only the
  // first read shows the loading state; refreshes update the tables in place.
  async function load() {
    const f = readForge();
    // Tables for a name the page has since navigated away from are dropped.
    const name = campaign;
    readAs = auth.user?.login ?? null;
    if (!loaded) loading = true;
    loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, ctx(f));
      if (name !== campaign) return;
      notInitialised = tables.notInitialised;
      isPrivate = tables.isPrivate;
      canPush = tables.canPush;
      taskDefs = tables.taskDefs;
      rows = tables.rows;
      validationColumns = tables.validationColumns;
      locks = tables.locks;
      history = tables.history;
      comments = tables.comments;
      pieces = tables.pieces;
      logins = tables.logins;
      title = tables.title;
      recordCampaignTitle(name, tables.title);
      description = tables.description;
      license = tables.license;
      passThreshold = tables.passThreshold;
      allowSelfValidation = tables.allowSelfValidation;
      if (!notInitialised) {
        console.log(
          "[load] tables loaded:",
          taskDefs.length,
          "task(s),",
          rows.length,
          "state row(s),",
          locks.length,
          "lock(s),",
          comments.length,
          "comment(s)",
        );
      }
      loaded = true;
    } catch (e) {
      if (name === campaign) loadError = campaignLoadFailure(e);
    } finally {
      if (name === campaign) loading = false;
    }
  }

  // A same-route navigation to another campaign starts over: the resolved
  // repo and the loaded tables belong to the previous name.
  $effect(() => {
    void campaign;
    resolved = null;
    notFound = false;
    resolveError = null;
    slugState = null;
    loaded = false;
    loadError = null;
    scoreHead = null;
    scoreHeadState = "idle";
  });

  // Resolve the campaign name to its repo before anything reads the tables. The
  // load effect below is gated on `owner`/`repo`, so it waits for this.
  // The URL is the campaign's address (/<name>), so the name's registry state
  // decides what the page is: a live campaign renders, a free name forwards to
  // the wizard with the name prefilled, and a name that is held, reserved or
  // blocked explains itself.
  $effect(() => {
    if (
      auth.status === "loading" ||
      resolved ||
      notFound ||
      resolveError ||
      slugState ||
      resolving
    )
      return;
    resolving = true;
    resolve().finally(() => (resolving = false));
  });

  async function resolve() {
    // Results for a name the page has since navigated away from are dropped.
    const name = campaign;
    let info: SlugInfo | null;
    try {
      info = await lookupSlug(name);
    } catch (e) {
      if (name === campaign) resolveError = campaignLoadFailure(e);
      return;
    }
    if (name !== campaign) return;
    if (info?.status === "free") {
      await goto(`/new?slug=${encodeURIComponent(name)}`, {
        replaceState: true,
      });
      return;
    }
    if (
      info?.status === "pending" ||
      info?.status === "reserved" ||
      info?.status === "tombstoned"
    ) {
      slugState = info.status;
      return;
    }
    // Active — or the name malformed, which resolveCampaign reports as null
    // (notFound). A thrown forge error (e.g. rate limit) is a failed lookup,
    // not a missing campaign. The lookup above
    // is passed through so the name is not fetched from the registry twice.
    let r: ResolvedCampaign | null = null;
    try {
      r = await resolveCampaign(readForge(), name, info);
    } catch (e) {
      if (name === campaign) resolveError = campaignLoadFailure(e);
      return;
    }
    if (name !== campaign) return;
    if (r) resolved = r;
    else notFound = true;
  }

  $effect(() => {
    if (auth.status !== "loading" && owner && repo && !loaded) load();
  });

  // The push permission and the owner's views belong to the viewer the tables
  // were read as. When the viewer changes (a logout or an expired session),
  // they are dropped at once and the tables are read again as the new viewer.
  $effect(() => {
    if (loaded && (auth.user?.login ?? null) !== readAs) {
      canPush = false;
      manage = false;
      loaded = false;
    }
  });

  // Background verdicts refresh the tables when they land — unless a command
  // overlay is up, whose own after-refresh will catch the change, or the
  // campaign isn't resolved (nothing to refresh).
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (!runner.busy && owner && repo) load();
    }),
  );

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(
    command: (c: CommandContext) => Promise<Result>,
    refresh = true,
  ) {
    const f = forge();
    if (!f) return null;
    return runner.run(
      () => command(ctx(f)),
      async (result) => {
        // A background command changed nothing yet — the settle listener
        // refreshes when its verdict lands.
        if (refresh && !result.background) {
          runner.log.step("Refreshing tables…");
          await load();
        }
      },
    );
  }

  // Claiming a validation slot opens the place the review happens — a
  // pre-task's own editor, or the review view for encoding tasks — but only
  // on a clean claim, so a rejected claim leaves you on the console.
  const claimValidate = async (task_id: string, subtask_id: string) => {
    actedOn(task_id);
    const result = await run((c) =>
      invoke(commands.claimValidation, { task_id, subtask_id }, c),
    );
    if (!result?.ok || result.warn) return;
    const locator = taskDefs.find(
      (t) => t.task_id === task_id && t.subtask_id === "",
    )?.locator;
    await goto(reviewHref(campaign, locator ?? "", task_id));
  };

  // Open the task's score in mei-friend (claiming it if needed). The page
  // navigates only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  const editor = async (task_id: string) => {
    // A claim still being processed holds the editor until its verdict lands.
    if (pendingVerdicts.isProcessing(`claim:${task_id}`, repoId)) return;
    actedOn(task_id);
    const result = await run((c) =>
      invoke(
        commands.openEditor,
        { task_id, campaign, base: location.origin },
        c,
      ),
    );
    openMeiFriend(result);
  };

  const submitpr = (task_id: string) =>
    run((c) => invoke(commands.submitEncoding, { task_id }, c));

  const giveBack = (task_id: string, subtask_id: string) => {
    actedOn(task_id);
    return run((c) => invoke(commands.giveBack, { task_id, subtask_id }, c));
  };

  // ------------------------------------------------ the return from mei-friend
  // mei-friend returns the volunteer to /<campaign>?task=<id>&mf_status=
  // complete|failed|abandoned (with an optional mf_msg). `complete` submits the
  // encoding, `abandoned` gives the claim back, `failed` shows mei-friend's
  // message in the side panel.
  /** An error from the return from mei-friend, shown in the task's panel;
      `label` names mei-friend when the text is its own message. */
  let editorError = $state<{
    task: string;
    label: string;
    text: string;
  } | null>(null);
  /** The task mei-friend just reported complete, highlighted until `until`. */
  let completed = $state<{ task: string; until: number } | null>(null);
  const COMPLETED_HIGHLIGHT_MS = 5 * 60_000;
  const completedTask = $derived(completed?.task ?? null);
  // The next task's own control only opens it (the viewer's claimed work):
  // with it open, its task box holds the action.
  const nextOpensOnly = $derived(
    !!nextCard &&
      nextCard.column !== "ready" &&
      !(
        nextCard.column === "validation" &&
        nextCard.slots.some((s) => s.claimable)
      ),
  );

  $effect(() => {
    if (!completed) return;
    const timer = setTimeout(
      () => (completed = null),
      completed.until - Date.now(),
    );
    return () => clearTimeout(timer);
  });
  // Acting on another task ends the highlight and the reported error.
  function actedOn(task: string) {
    if (completed && completed.task !== task) completed = null;
    if (editorError && editorError.task !== task) editorError = null;
  }
  const holdsEncoding = (task: string) =>
    viewer !== "" &&
    locks.some(
      (l) =>
        l.task_id === task &&
        l.subtask_id === "" &&
        l.kind === "encoding" &&
        l.user_id === viewer,
    );
  function handleEditorReturn(task: string, status: string, msg: string) {
    console.log("[editor-return]", task, status, {
      holds: holdsEncoding(task),
      msg,
    });
    if (status === "failed") {
      editorError = msg
        ? { task, label: "Message from mei-friend", text: msg }
        : {
            task,
            label: "",
            text: "mei-friend reported that the task could not be completed.",
          };
      return;
    }
    if (status !== "complete" && status !== "abandoned") return;
    if (!holdsEncoding(task)) {
      editorError = {
        task,
        label: "",
        text:
          status === "complete"
            ? "mei-friend reported the task complete, but you do not hold its claim, so nothing was submitted."
            : "mei-friend reported the task given back, but you do not hold its claim.",
      };
      return;
    }
    if (status === "complete") {
      completed = { task, until: Date.now() + COMPLETED_HIGHLIGHT_MS };
      submitpr(task);
    } else giveBack(task, "");
  }

  const validate = (
    task_id: string,
    subtask_id: string,
    verdict: string,
    comment?: FailComment,
  ) => {
    actedOn(task_id);
    return run((c) =>
      invoke(
        commands.submitValidation,
        { task_id, subtask_id, verdict, ...(comment ? { comment } : {}) },
        c,
      ),
    );
  };

  const sendBackTask = (task_id: string) => {
    actedOn(task_id);
    return run((c) => invoke(commands.sendBack, { task_id }, c));
  };

  const postComment = (
    task_id: string,
    kind: string,
    body: string,
    parent_id: string,
    at?: CommentAnchorInput,
  ) =>
    run((c) =>
      invoke(
        commands.submitComment,
        commentInput(task_id, kind, body, parent_id, at),
        c,
      ),
    );

  const resolveCommentRow = (comment_id: string) =>
    run((c) => invoke(commands.resolveComment, { comment_id }, c));

  const reaper = () => run((c) => invoke(commands.runReaper, {}, c));

  // Save the edited plan; a clean save leaves the manage takeover (run() has
  // already refreshed the tables, so the board reflects the new plan).
  async function savePlan(tasks: TaskRow[]) {
    const result = await run((c) => invoke(commands.savePlan, { tasks }, c));
    if (result?.ok) manage = false;
  }

  // Deep links, read once after the first load: ?task= opens that task's
  // detail. On the owner's board the side panel reopens the task chosen last
  // time, if any; the score view shows a task only from ?task=.
  let deepLinked = false;
  $effect(() => {
    if (!loaded || deepLinked) return;
    deepLinked = true;
    const task = page.url.searchParams.get("task");
    if (task && findRow(taskDefs, task, "")) {
      detailTask = task;
      const status = page.url.searchParams.get("mf_status");
      if (status) {
        // Logged out, the outcome waits in the URL; logging in returns here
        // with it.
        if (!auth.user) {
          editorError = {
            task,
            label: "",
            text: "Log in to record the outcome from mei-friend.",
          };
          return;
        }
        const msg = page.url.searchParams.get("mf_msg") ?? "";
        // The outcome is handled once; a reload must not repeat it.
        goto(`/${campaign}?task=${encodeURIComponent(task)}`, {
          replaceState: true,
          noScroll: true,
          keepFocus: true,
        });
        handleEditorReturn(task, status, msg);
      }
      return;
    }
    // The owner's board reopens the task chosen last time only while it is
    // the owner's own claimed work; otherwise it opens on the campaign.
    if (!canPush || scoreView) return;
    const last = readLastTask(campaign);
    if (last && locks.some((l) => l.task_id === last && l.user_id === viewer))
      detailTask = last;
  });

  function claimCard(card: BoardCard) {
    actedOn(card.task);
    if (card.pre) goto(preTaskHref(campaign, card.locator, card.task));
    else editor(card.task);
  }
  // Act on a card the viewer can work on: claim it when it is open, claim its
  // free validation slot when it awaits review, otherwise open its detail
  // (their claimed work lives there).
  function actOnCard(card: BoardCard) {
    if (card.column === "ready") {
      claimCard(card);
      return;
    }
    const sub = card.slots.find((s) => s.claimable)?.sub;
    if (card.column === "validation" && sub !== undefined) {
      actedOn(card.task);
      claimValidate(card.task, sub);
    } else openTask(card.task);
  }
  function actOnNext() {
    if (nextCard) actOnCard(nextCard);
  }

  // The side panel names its piece and carries its colour.
  const pieceNameOf = (task: string) => {
    const p = previewPieces[pieceIndexByTask.get(task) ?? 0];
    return p ? pieceLabel(p) : "";
  };
  const zoneOf = (task: string) => pieceZone(pieceIndexByTask.get(task) ?? 0);

  // The board rendered as four columns: queued-but-blocked tasks share the
  // Open column (dimmed, with what they wait for) instead of a fifth column.
  const displayColumns = $derived.by(() => {
    const by = new Map(board.columns.map((c) => [c.key, c]));
    const ready = by.get("ready");
    const blocked = by.get("blocked");
    const encoding = by.get("encoding");
    const validation = by.get("validation");
    const done = by.get("done");
    return [
      {
        key: "ready" as ColumnKey,
        label: "Open",
        cards: [...(ready?.cards ?? []), ...(blocked?.cards ?? [])],
      },
      {
        key: "encoding" as ColumnKey,
        label: "Encoding",
        cards: encoding?.cards ?? [],
      },
      {
        key: "validation" as ColumnKey,
        label: "Review",
        cards: validation?.cards ?? [],
      },
      {
        key: "done" as ColumnKey,
        label: "Done",
        cards: done?.cards ?? [],
      },
    ];
  });
  // The rail's selection filters the rendered columns to one piece; the
  // stats-bar toggle keeps only the claimable cards. Every column stays in
  // view, however empty the filters leave it.
  const scopedColumns = $derived.by(() => {
    let cols = displayColumns;
    if (selectedPiece !== "all")
      cols = cols.map((col) => ({
        ...col,
        cards: col.cards.filter(
          (c) =>
            previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path ===
            selectedPiece,
        ),
      }));
    if (boardScope === "open")
      cols = cols.map((col) => ({
        ...col,
        cards: col.cards.filter(actionable),
      }));
    return cols;
  });

  // The reaper's last trace in the history, for the manage header.
  const lastReap = $derived(
    history.findLast((h) => h.action === "reap") ?? null,
  );
  const elapsedLabel = (iso: string) => {
    const e = elapsed(iso);
    return e === "now" ? "just now" : `${e} ago`;
  };
</script>

<svelte:head>
  <title>{title || campaign} · Let's Encode!</title>
</svelte:head>

<svelte:window
  bind:innerWidth={windowWidth}
  onkeydown={(e) => {
    if (e.key !== "Escape") return;
    if (scoreView) closeScoreView();
    else if (detailTask) closeTask();
  }}
/>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

{#snippet resultBanner()}
  <RunnerBanner {runner} bar {isPrivate} />
{/snippet}

{#snippet slotDot(key: string, who = "")}
  <span
    class="dot {key}"
    role="img"
    aria-label={who ? `${key}: ${who}` : key}
    title={who || key}
  ></span>
{/snippet}

<!-- In the score view (inBoard false) the task box has no next-task control
     beside it, so its action stays the view's primary one. -->
{#snippet boardTaskBox(card: BoardCard, inBoard = true)}
  <TaskBox
    {card}
    pieceName={pieceNameOf(card.task)}
    zone={zoneOf(card.task)}
    {campaign}
    {comments}
    {locks}
    {rows}
    {logins}
    {viewer}
    {canPush}
    {runner}
    primary={!inBoard || (card.task === nextCard?.task && nextOpensOnly)}
    onshowanchor={showCommentInScore}
    onclaim={claimValidate}
    editorError={editorError?.task === card.task ? editorError : null}
    oneditor={editor}
    ongiveback={giveBack}
    onvalidate={validate}
    onresolve={resolveCommentRow}
    onsendback={sendBackTask}
  />
{/snippet}

<!-- The side panel of the board and the volunteer view: the selected task,
     else the campaign. -->
{#snippet sidePanelFor(card: BoardCard | null, emptyLine: string)}
  {#if card}
    <SidePanel
      task={card.task}
      zone={zoneOf(card.task)}
      review={card.column === "validation"}
      {comments}
      {logins}
      {viewer}
      {canPush}
      {runner}
      bind:panel={sidePanel}
      banner={resultBanner}
      ondeselect={closeTask}
      onanchor={showCommentInScore}
      oncomment={(kind, body, parent_id) =>
        postComment(card.task, kind, body, parent_id)}
      onresolve={resolveCommentRow}
    >
      {#snippet taskBox()}{@render boardTaskBox(card)}{/snippet}
    </SidePanel>
  {:else}
    <SidePanel
      task=""
      {emptyLine}
      info={canPush ? campaignInfo : undefined}
      {comments}
      {logins}
      {viewer}
      {canPush}
      {runner}
      bind:panel={sidePanel}
      onanchor={showCommentInScore}
      oncomment={(kind, body, parent_id) =>
        postComment("", kind, body, parent_id)}
      onresolve={resolveCommentRow}
    />
  {/if}
{/snippet}

<!-- The board filter: every task, or only the claimable ones. -->
{#snippet scopeSeg()}
  <div class="seg" role="group" aria-label="Board filter">
    <button
      type="button"
      class:on={boardScope === "all"}
      aria-pressed={boardScope === "all"}
      onclick={() => (boardScope = "all")}>All tasks</button
    >
    <button
      type="button"
      class:on={boardScope === "open"}
      aria-pressed={boardScope === "open"}
      onclick={() => (boardScope = "open")}
      title="Only tasks with something to do right now: open encodings and free review slots."
      >Claimable</button
    >
  </div>
{/snippet}

<!-- The campaign's details in the owner's side panel, above the campaign
     comments. -->
{#snippet campaignInfo()}
  <div class="cinfo">
    <div class="isec">
      <span class="seclabel">Score</span>
      {#if scoreHeadState === "loading"}
        <span class="muted inote">Loading the score header…</span>
      {:else if scoreHeadState === "error"}
        <span class="muted inote">Could not read the score.</span>
      {:else if scoreHeadState === "done" && !scoreHead}
        <span class="muted inote">The score has no MEI header.</span>
      {:else if scoreHead}
        <div class="irow">
          <span>Title</span>
          <span>{scoreHead.title || "—"}</span>
        </div>
        <div class="irow">
          <span>Composer</span>
          <span>{scoreHead.composer || "—"}</span>
        </div>
      {/if}
      <div
        class="irow"
        title="Everyone the campaign history records: claims, submissions and reviews."
      >
        <span>Worked on this</span>
        <span>
          {#if workedOn.length}
            {#each workedOn as u, i (u)}{i > 0 ? ", " : ""}<a
                class="mono"
                href={readForge().userWebUrl(logins[u] || u)}
                target="_blank"
                rel="noreferrer">@{logins[u] || u}</a
              >{/each}
          {:else}—{/if}
        </span>
      </div>
    </div>
    <div class="isec">
      <span class="seclabel">Campaign</span>
      <div class="irow">
        <span>Repository</span>
        <a
          class="mono"
          href={readForge().repoWebUrl(owner, repo)}
          target="_blank"
          rel="noreferrer">{owner}/{repo}</a
        >
      </div>
      <div class="irow">
        <span>About</span>
        <span>{description || "—"}</span>
      </div>
      <div class="irow">
        <span>Visibility</span>
        <span>{isPrivate ? "Private" : "Public"}</span>
      </div>
      <div
        class="irow"
        title="Contributions to this campaign are published under this license."
      >
        <span>License</span>
        <span>{license || "—"}</span>
      </div>
      <div
        class="irow"
        title="Passing reviews each task needs before it counts as done."
      >
        <span>Reviews required</span>
        <span>{passThreshold}</span>
      </div>
    </div>
  </div>
{/snippet}

<div class="console">
  {#if auth.status === "loading"}
    <p class="msg muted">Loading…</p>
  {:else}
    {#if !auth.user}
      <div class="banner bar warn">
        <span>
          {#if auth.expired}Your GitHub login has expired.{/if}
          Viewing this public campaign read-only.
          <button type="button" class="linkish" onclick={() => login()}
            >Log in with GitHub</button
          >
          to contribute.
        </span>
      </div>
    {/if}
    {#if !detailCard}
      {@render resultBanner()}
    {/if}

    {#if resolveError}
      <div class="banner bar err">
        <span>
          {resolveError}
          <button
            type="button"
            class="linkish"
            onclick={() => (resolveError = null)}>Try again</button
          >
        </span>
      </div>
    {:else if notFound && !isValidHandle(campaign)}
      <div class="banner bar err">
        <span>
          <code>{campaign}</code> cannot be a campaign name. Names are 3–40
          characters: lowercase letters, digits, and single internal hyphens.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else if notFound}
      <div class="banner bar err">
        <span>
          No campaign called <code>{campaign}</code> was found. It may have been
          removed, or the name may be misspelled.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else if slugState === "pending"}
      <div class="banner bar warn">
        <span>
          Someone is setting up a campaign called <code>{campaign}</code>. If
          they don't finish it, the name becomes free again.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else if slugState === "reserved"}
      <div class="banner bar err">
        <span>
          <code>{campaign}</code> is reserved and can't be used for a campaign.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else if slugState === "tombstoned"}
      <div class="banner bar err">
        <span>
          The name <code>{campaign}</code> has been blocked and can't be used.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else}
      <div class="viewcol">
        {#if !resolved}
          <p class="msg muted">Finding the campaign…</p>
        {:else if loading}
          <p class="msg muted">Loading campaign…</p>
        {:else if loadError}
          <div class="banner bar err"><span>{loadError}</span></div>
        {:else if notInitialised}
          <div class="banner bar warn">
            <span>
              This repository has no tracking tables (<code
                >tracking/task.csv</code
              >,
              <code>tracking/state.csv</code>, <code>tracking/lock.csv</code>)
              yet — it may not have been initialised. Create it through the home
              page to initialise it.
            </span>
          </div>
        {:else if scoreView}
          {#key scoreView.piece.path}
            <ScoreView
              bind:this={scoreViewRef}
              piece={scoreView.piece}
              campaignTitle={title || repo}
              {owner}
              {repo}
              startPage={scoreStartPage}
              {anchor}
              card={detailCard}
              cardOnPiece={!!detailCard &&
                (pieceIndexByTask.get(detailCard.task) ?? 0) ===
                  scoreView.index}
              cardZone={detailCard ? zoneOf(detailCard.task) : 0}
              banner={resultBanner}
              {comments}
              {logins}
              {viewer}
              {canPush}
              {runner}
              bind:panel={sidePanel}
              ondeselect={closeTask}
              onopenanchor={showCommentInScore}
              oncomment={postComment}
              onresolve={resolveCommentRow}
            >
              {#snippet taskBox()}{#if detailCard}{@render boardTaskBox(
                    detailCard,
                    false,
                  )}{/if}{/snippet}
            </ScoreView>
          {/key}
        {:else if manage && canPush}
          <div class="crumbrow">
            <button
              type="button"
              class="backlink"
              onclick={() => (manage = false)}
              ><Icon name="arrow-left" /> Back to the board</button
            >
            <span class="bcsep">/</span>
            <span class="crumbtitle">{title || repo}</span>
            <span class="crumbsub">· Manage</span>
            <span class="ownerpill">owner</span>
            <span class="cspacer"></span>
            <span class="reapline">
              {#if lastReap}
                Expired claims were last released {elapsedLabel(
                  lastReap.timestamp,
                )}
              {:else}
                No expired claims have been released yet
              {/if}
            </span>
            <button
              type="button"
              class="btn"
              onclick={() => reaper()}
              disabled={runner.busy}
              title="Releases the claims whose lock has expired"
              >Release expired claims now</button
            >
          </div>
          <PlanEditor
            {taskDefs}
            {rows}
            {validationColumns}
            {locks}
            {logins}
            {pieceNames}
            preparations={piecePreparations}
            busy={runner.busy}
            onsave={savePlan}
            oncancel={() => (manage = false)}
          />
        {:else if !canPush}
          <!-- Split (panelOut): the list scrolls above or beside the panel. -->
          <div class="volsplit" class:split={panelOut}>
            <div class="volwrap">
              <div class="volcenter">
                <div class="volhead">
                  <div class="voltitle">
                    <h1 title={title || repo}>{title || repo}</h1>
                    {#if volStanding}
                      <span class="volstanding">{volStanding}</span>
                    {/if}
                  </div>
                  <span class="volprogress">
                    <span class="vbar"
                      ><span
                        style={`width:${board.total ? Math.round((board.done / board.total) * 100) : 0}%`}
                      ></span></span
                    >
                    <span class="volcount"
                      >{board.done} of {board.total} done</span
                    >
                  </span>
                  {#if canViewScore}
                    <button
                      type="button"
                      class="btn scorebtn"
                      onclick={viewContextScore}
                      title={scoreHint}>View score</button
                    >
                  {/if}
                </div>
                <div class="volrow sidehost">
                  <VolunteerView
                    {owner}
                    {repo}
                    cards={allCards}
                    {nextCard}
                    {completedTask}
                    {taskDefs}
                    {locks}
                    {viewer}
                    pieces={previewPieces}
                    progress={pieceProgress}
                    pieceIndex={pieceIndexByTask}
                    busy={runner.busy}
                    shownTask={detailTask}
                    onact={actOnCard}
                    onopen={openTask}
                  />
                  {#if !panelOut}
                    <div class="sideslot">
                      {@render sidePanelFor(
                        detailCard,
                        "Select a task to show it here.",
                      )}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
            {#if panelOut}
              <div class="panelslot">
                {@render sidePanelFor(
                  detailCard,
                  "Select a task to show it here.",
                )}
              </div>
            {/if}
          </div>
        {:else}
          <!-- Split (panelOut): the board scrolls above or beside the panel. -->
          <div class="boardview" class:split={panelOut}>
            <div class="boardscroll">
              <div class="hero">
                <div class="hero-line">
                  <h1 title={title || repo}>{title || repo}</h1>
                  <a
                    class="mono slug"
                    href={readForge().repoWebUrl(owner, repo)}
                    target="_blank"
                    rel="noreferrer"
                    >{owner}/{repo} <Icon name="external" size={12} /></a
                  >
                  <div class="hero-acts">
                    {#if auth.user && canPush}
                      <button
                        type="button"
                        class="btn managechip"
                        onclick={() => (manage = true)}
                        disabled={runner.busy}
                        aria-label="Manage"
                        title="Owner only: plan editor and expired-claim release"
                        ><Icon name="gear" /><span class="managelabel"
                          >Manage</span
                        ></button
                      >
                    {/if}
                    {#if canViewScore}
                      <button
                        type="button"
                        class="btn scorebtn"
                        onclick={viewContextScore}
                        title={scoreHint}>View score</button
                      >
                    {/if}
                    <!-- Only while there is a task to act on: logged out, the
                         banner offers the login; with nothing open, no
                         button stands in for it. -->
                    {#if auth.user && nextCard}
                      <button
                        type="button"
                        class="btn btn-primary claimbtn"
                        disabled={runner.busy}
                        title={nextOpensOnly
                          ? "Open the task you have claimed."
                          : "Claim the first task that is open for you."}
                        onclick={actOnNext}
                        >{nextOpensOnly
                          ? "Open your task"
                          : "Claim the next task"}</button
                      >
                    {/if}
                  </div>
                </div>
                <!-- One line: the progress first; the other counts give way
                     as the column narrows, the attention count last. -->
                <div class="hero-stats" class:quiet={board.attention === 0}>
                  <div class="hbar">
                    <div
                      style={`width:${board.total ? Math.round((board.done / board.total) * 100) : 0}%`}
                    ></div>
                  </div>
                  <span class="hbarlabel"
                    >{board.done} of {board.total} tasks done</span
                  >
                  <span class="sep m2">·</span>
                  <span class="stat m2"
                    ><b class="c-info">{board.inFlight}</b> in progress</span
                  >
                  {#if board.attention > 0}
                    <span class="sep m2">·</span>
                    <button
                      type="button"
                      class="stat statbtn"
                      onclick={() => (showAttention = !showAttention)}
                      title="Show the tasks with unresolved fails or comments."
                      ><b>{board.attention}</b> need{board.attention === 1
                        ? "s"
                        : ""} attention <Icon
                        name={showAttention ? "chevron-down" : "chevron-right"}
                        size={12}
                      /></button
                    >
                  {:else}
                    <span class="sep m2">·</span>
                    <span class="stat m2"><b>0</b> need attention</span>
                  {/if}
                  <span class="sep m1">·</span>
                  <span class="stat m1"
                    ><b>{board.contributorsWeek}</b>
                    contributor{board.contributorsWeek === 1 ? "" : "s"} this week</span
                  >
                  {@render scopeSeg()}
                </div>
                {#if showAttention && attentionCards.length > 0}
                  <div class="attnbox">
                    {#each attentionCards as card (card.task)}
                      <button
                        type="button"
                        class="attnrow"
                        onclick={() => openTask(card.task)}
                        title="Open this task"
                      >
                        <span class="attntitle">{card.title}</span>
                        <span class="attnspacer"></span>
                        {#if card.counts.fails > 0}
                          <span class="chip chip-fail"
                            >{card.counts.fails} fail{card.counts.fails === 1
                              ? ""
                              : "s"}</span
                          >
                        {/if}
                        {#if card.counts.comments > 0}
                          <span class="chip chip-note"
                            >{card.counts.comments} comment{card.counts
                              .comments === 1
                              ? ""
                              : "s"}</span
                          >
                        {/if}
                        <span class="attnchev"
                          ><Icon name="chevron-right" /></span
                        >
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>

              <div class="instrow sidehost" bind:contentRect={instrowBox}>
                {#if previewPieces.length > 0 && !railChips}
                  <div class="railslot">
                    <PieceRail
                      pieces={previewPieces}
                      chips={false}
                      progress={pieceProgress}
                      counts={railCounts}
                      attention={attentionByPiece}
                      openCount={displayColumns[0].cards.length}
                      selected={selectedPiece}
                      onselect={(sel) => (selectedPiece = sel)}
                    />
                  </div>
                {/if}
                <div class="boardcol">
                  {#if railChips}
                    <!-- On a phone the board filter joins the piece dots;
                         the header keeps it elsewhere. -->
                    <div class="boardtools">
                      {#if previewPieces.length > 0}
                        <PieceRail
                          pieces={previewPieces}
                          chips
                          progress={pieceProgress}
                          counts={railCounts}
                          attention={attentionByPiece}
                          openCount={displayColumns[0].cards.length}
                          selected={selectedPiece}
                          onselect={(sel) => (selectedPiece = sel)}
                        />
                      {/if}
                      {@render scopeSeg()}
                    </div>
                  {/if}
                  {#if railPiece}
                    {@const p = pieceProgress.get(railPiece.piece.path)}
                    <div
                      class="ctxstrip"
                      style="--zone: var(--zone-{pieceZone(railPiece.index)})"
                    >
                      <span class="ctxpaper">
                        {#if stripPreview?.thumb}
                          <img src={stripPreview.thumb} alt="" loading="lazy" />
                        {/if}
                      </span>
                      <div class="ctxinfo">
                        <span
                          class="ctxname"
                          title={pieceLabel(railPiece.piece)}
                          >{clipTitle(pieceLabel(railPiece.piece))}</span
                        >
                        <span class="ctxmeta"
                          >{stripPreview?.pageMeasures.length
                            ? `${stripPreview.pageMeasures.length} page${stripPreview.pageMeasures.length === 1 ? "" : "s"} · ${stripPreview.pageMeasures.reduce((a, b) => a + b, 0)} measures · `
                            : ""}{p?.done ?? 0} of {p?.total ?? 0} done</span
                        >
                      </div>
                      <div class="ctxincipit">
                        {#if stripPreview?.incipit}
                          {@html stripPreview.incipit}
                        {:else if stripPreview?.incipitPending}
                          <span class="ctxincnote"
                            >incipit appears after the setup tasks</span
                          >
                        {/if}
                      </div>
                    </div>
                  {/if}
                  <!-- A toggle group: the pressed lane is the one shown. -->
                  <div class="lanetabs" role="group" aria-label="Lanes">
                    {#each scopedColumns as col (col.key)}
                      <button
                        type="button"
                        class="lanetab c-{col.key}"
                        class:on={laneTab === col.key}
                        aria-pressed={laneTab === col.key}
                        onclick={() => (pickedLane = col.key)}
                        >{col.label}
                        <span class="lanetab-count">{col.cards.length}</span
                        ></button
                      >
                    {/each}
                  </div>
                  {#if boardScope === "open" && scopedColumns.every((c) => c.cards.length === 0)}
                    <p class="boardnote">No task can be claimed right now.</p>
                  {/if}
                  <div class="board">
                    {#each scopedColumns as col (col.key)}
                      <div
                        class="bcol c-{col.key}"
                        class:tabsel={laneTab === col.key}
                        class:empty={col.cards.length === 0}
                      >
                        <div class="bcol-head">
                          <h2 class="bcol-name">{col.label}</h2>
                          <span class="bcol-count">{col.cards.length}</span>
                        </div>
                        <div class="well">
                          {#if col.cards.length === 0}
                            <p class="laneempty">No tasks</p>
                          {/if}
                          {#each col.cards as card (card.task)}
                            <!-- A focusable div, not a <button>: the run state inside
                         it can render a PR link, which HTML does not allow
                         nested in a button. -->
                            <div
                              class="card col-{card.column}"
                              class:nextup={card.nextUp && !completedTask}
                              class:justmoved={recentlyFinished.has(
                                card.task,
                              ) || card.task === completedTask}
                              class:paneled={detailTask === card.task}
                              aria-current={detailTask === card.task
                                ? "true"
                                : undefined}
                              class:failtint={card.counts.fails > 0 &&
                                card.column !== "done"}
                              role="button"
                              tabindex="0"
                              onclick={() => openTask(card.task)}
                              onkeydown={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  openTask(card.task);
                                }
                              }}
                              title="Open this task"
                            >
                              {#if card.nextUp && !completedTask}
                                <span class="nextup-badge">next task</span>
                              {/if}
                              {#if card.task === completedTask}
                                <span class="justmoved-badge"
                                  >just completed</span
                                >
                              {:else if recentlyFinished.has(card.task)}
                                <span class="justmoved-badge"
                                  >just submitted</span
                                >
                              {/if}
                              <div class="card-title">
                                {card.description}{#if card.scope}<span
                                    class="card-scope"
                                    >{` · ${card.scope}`}</span
                                  >{/if}
                              </div>
                              {#if piecesListed}
                                <div
                                  class="card-piece"
                                  style="--zone: var(--zone-{zoneOf(
                                    card.task,
                                  )})"
                                >
                                  <span class="piece-dot"></span>
                                  <span class="card-pname" title={card.piece}
                                    >{clipTitle(card.piece)}</span
                                  >
                                </div>
                              {/if}
                              {#if card.column === "validation"}
                                <div class="card-type">
                                  {card.passes} of {card.threshold} review{card.threshold ===
                                  1
                                    ? ""
                                    : "s"}
                                </div>
                              {/if}
                              <TaskRunState task={card.task} />
                              {#if card.column === "blocked"}
                                <div class="card-foot">
                                  waits for <strong>{card.waitsFor}</strong>
                                </div>
                              {:else if card.column === "encoding" && card.worker}
                                <div class="card-worker">
                                  <span class="avatar"
                                    >{initialOf(card.worker.login)}</span
                                  >
                                  <span class="worker-line"
                                    >{card.worker.login} · {card.worker
                                      .expires}</span
                                  >
                                </div>
                              {:else if card.column === "validation"}
                                <!-- Who holds each review slot, as the
                                     encoding lane shows its worker. -->
                                {#each card.slots.filter((s) => s.key === "review" && s.user) as slot (slot.label)}
                                  <div class="card-worker">
                                    <span class="avatar review"
                                      >{initialOf(
                                        handle(logins, slot.user),
                                      )}</span
                                    >
                                    <span class="worker-line review"
                                      >{handle(logins, slot.user)} · {reviewExpiry(
                                        card.task,
                                        slot.sub,
                                        slot.user,
                                      )}</span
                                    >
                                  </div>
                                {/each}
                                <div class="card-dots">
                                  {#each card.slots as slot (slot.label)}
                                    {@render slotDot(slot.key, slot.who)}
                                  {/each}
                                </div>
                              {:else if card.column === "done"}
                                <div class="card-done">
                                  <img
                                    class="hand-done"
                                    src="/green-hand.svg"
                                    alt=""
                                  />
                                  {card.doneLine || "done"}{card.finishedAt
                                    ? ` · ${elapsedLabel(card.finishedAt)}`
                                    : ""}
                                </div>
                              {/if}
                              {#if card.column !== "done" && card.counts.fails + card.counts.comments > 0}
                                <div class="card-chips">
                                  {#if card.counts.fails > 0}
                                    <span class="chip chip-fail"
                                      >{card.counts.fails} fail{card.counts
                                        .fails === 1
                                        ? ""
                                        : "s"}</span
                                    >
                                  {/if}
                                  {#if card.counts.comments > 0}
                                    <span class="chip chip-note"
                                      >{card.counts.comments} comment{card
                                        .counts.comments === 1
                                        ? ""
                                        : "s"}</span
                                    >
                                  {/if}
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
                {#if !panelOut}
                  {@render sidePanelFor(
                    detailCard,
                    "Select a task on the board to show it here.",
                  )}
                {/if}
              </div>
            </div>
            {#if panelOut}
              <div class="panelslot">
                {@render sidePanelFor(
                  detailCard,
                  "Select a task on the board to show it here.",
                )}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .console {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-alt);
    background-image:
      radial-gradient(60% 90% at 15% 0%, var(--glow-blue), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, var(--glow-green), transparent 60%);
    /* Board-only aliases onto the global recessed-surface tokens. */
    --well: var(--bg-inset);
    --track: var(--bg-tint);
    --hairline: var(--line);
  }
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .muted {
    color: var(--ink-faint);
  }
  .msg {
    padding: 1rem 1.4rem;
  }

  /* Banner styles are shared app-wide in ui.css. */
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
  .linkish:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --------------------------------------------------------------- main */
  /* The view fills the window — the rail, board and side panel share every
     available column. Its minimum height is its content's. The width minimum
     is explicit: the inline-size containment below makes the content's own
     width invisible to sizing, and the board's stacking reacts to the
     column's width instead. */
  /* The column caps at the window: the board, the score view and the
     volunteer view scroll inside their own regions, and where their least
     sizes do not fit the window the column itself scrolls. */
  .viewcol {
    flex: 1;
    min-width: 340px;
    min-height: 0;
    overflow-y: auto;
    width: 100%;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
    container-name: view;
  }
  /* Split (portrait up to tablet width, or a short window): the content and
     the side panel share the window, the panel docked below in portrait
     (DOCKED_QUERY) and beside in a short window. The content scrolls as one
     region, its sections at their content's height; a gap separates it from
     the panel. */
  .volsplit,
  .boardview,
  .boardscroll {
    display: contents;
  }
  .volsplit.split,
  .boardview.split {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .split > .volwrap,
  .split > .boardscroll {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
    container-name: view;
  }
  .panelslot {
    flex: none;
    min-height: 0;
    display: flex;
    padding: 12px 16px 12px 0;
    box-sizing: border-box;
  }
  @media (orientation: portrait) and (max-width: 900px) {
    .volsplit.split,
    .boardview.split {
      flex-direction: column;
    }
    .panelslot {
      flex-direction: column;
      padding: 10px 0 0;
    }
  }
  .split .volcenter,
  .split .volrow,
  .split .instrow,
  .split .board {
    flex: none;
    min-height: 0;
  }
  .split .board {
    overflow-y: visible;
  }
  .split :global(.volunteer) {
    overflow-y: visible;
    padding-right: 0;
    scrollbar-gutter: auto;
  }
  .split .bcol {
    min-height: auto;
  }
  .split .well {
    overflow-y: visible;
    contain: none;
  }

  /* The volunteer view: the header row, the task column and the side panel
     form one centred group, at most 1750px wide with its padding, clear of
     the footer. */
  .volwrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    padding: 18px 32px 14px;
    box-sizing: border-box;
  }
  .volcenter {
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: calc(1750px - 64px);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .volhead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    /* The header follows the row's width instead of contributing its own —
       a long title wraps rather than widening the group. */
    width: 0;
    min-width: 100%;
    box-sizing: border-box;
  }
  .volhead h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
  }
  .voltitle {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .volstanding {
    font-size: 12px;
    color: var(--ink-soft);
  }
  /* The campaign's progress: a bar beside the count. */
  .volprogress {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .vbar {
    width: 140px;
    height: 6px;
    border-radius: 3px;
    background: var(--track);
    overflow: hidden;
  }
  .vbar span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .volcount {
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
    flex: none;
  }
  .volrow {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
  }
  /* The side panel's top edge lines up with the next-task card, below its
     badge. */
  .sideslot {
    flex: none;
    min-height: 0;
    display: flex;
    padding-top: 9px;
    box-sizing: border-box;
  }
  /* Narrow column: the header wraps its title over the count. */
  @container (max-width: 700px) {
    .volwrap {
      padding: 12px 16px 14px;
    }
    /* Two lines: the title beside the score button, the viewer's standing
       beside the progress. */
    .volhead {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 12px;
    }
    .voltitle {
      display: contents;
    }
    .volhead h1 {
      grid-area: 1 / 1;
      align-self: center;
      font-size: 20px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .scorebtn {
      grid-area: 1 / 2;
    }
    .volstanding {
      grid-area: 2 / 1;
      align-self: center;
    }
    .volprogress {
      grid-area: 2 / 2;
      justify-self: end;
    }
    .vbar {
      width: 72px;
    }
  }

  /* ---------------------------------------------------- campaign details */
  /* The owner's side panel, above the campaign comments. */
  .cinfo {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 2px 2px 12px;
    border-bottom: 1px solid var(--line);
  }
  .isec {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .inote {
    font-size: 11px;
  }
  /* A fixed label column with the value directly after it, left-aligned. */
  .irow {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 10px;
    font-size: 12px;
  }
  /* On the recessed panel, labels take the soft ink (faint ink is for the
     canvas and cards). */
  .irow > span:first-child {
    color: var(--ink-soft);
  }
  .irow > :last-child {
    overflow-wrap: anywhere;
  }
  .irow a {
    color: var(--link);
    text-decoration: none;
  }
  .irow a:hover {
    text-decoration: underline;
  }
  .seclabel {
    font-weight: 600;
    font-size: 12px;
    color: var(--ink-soft);
  }

  /* ---------------------------------------------------------------- hero */
  .hero {
    flex: none;
    padding: 18px 32px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  /* The title and its repository link lead; the actions follow on the same
     line where they fit and wrap below it, right-aligned, where they do not.
     A title longer than the line wraps rather than being cut. */
  .hero-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
    min-width: 0;
  }
  .hero-line h1 {
    margin: 0;
    min-width: 0;
    font-size: 26px;
    line-height: 1.2;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .hero-acts {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .slug {
    font-size: 13px;
    color: var(--ink-faint);
    text-decoration: none;
    flex: none;
    /* A 24px pointer target without moving the text. */
    padding: 5px 0;
    margin: -5px 0;
  }
  .slug:hover {
    text-decoration: underline;
  }
  .cspacer {
    flex: 1;
  }
  /* Sizing comes from .btn.btn-lg; only the owner-amber tint is local. */
  .managechip {
    color: var(--owner);
    background: var(--owner-bg);
    border-color: var(--owner-line);
  }
  .managechip:hover:not(:disabled) {
    color: var(--owner);
    border-color: var(--owner);
  }
  .managechip {
    gap: 6px;
  }
  .hero-stats {
    display: flex;
    gap: 10px;
    align-items: center;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 5px 6px 5px 16px;
    box-shadow: var(--shadow-sm);
  }
  .hero-stats > * {
    white-space: nowrap;
  }
  .hero-stats .seg {
    margin-left: auto;
  }
  @container (max-width: 1100px) {
    .hero-stats .m1 {
      display: none;
    }
  }
  .hbar {
    flex: 1;
    min-width: 48px;
    max-width: 420px;
    height: 6px;
    border-radius: 3px;
    background: var(--track);
    overflow: hidden;
  }
  .hbar div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .hbarlabel {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .stat {
    font-size: 13px;
    color: var(--ink-soft);
  }
  .stat b.c-info {
    color: var(--info);
  }
  .sep {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .statbtn {
    font: inherit;
    font-size: 13px;
    color: var(--danger);
    background: none;
    border: 0;
    padding: 5px 0;
    margin: -5px 0;
    cursor: pointer;
    text-decoration: underline;
  }
  /* The tasks behind the attention count, unfolded from the stat. */
  .attnbox {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
    border-radius: 12px;
    padding: 10px 14px;
  }
  .attnrow {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 14px;
    cursor: pointer;
  }
  .attnrow:hover {
    border-color: var(--accent);
  }
  .attntitle {
    font-weight: 600;
  }
  .attnspacer {
    flex: 1;
  }
  .attnchev {
    font-size: 15px;
    color: var(--ink-faint);
  }
  /* -------------------------------------------------------------- pieces */
  /* ---------------------------------------- rail · board · side panel row */
  .instrow {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
    /* Clear of the footer. */
    padding: 0 32px 14px;
  }
  .railslot {
    flex: none;
    display: flex;
    min-height: 0;
    align-self: flex-start;
    max-height: 100%;
  }
  @media (max-width: 1100px) {
    .instrow {
      padding: 0 20px 14px;
    }
  }
  .boardcol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    /* The board's stacking query measures this column, which the rail and
       the side panel narrow independently of the window. */
    container-type: inline-size;
  }
  /* The scoped piece's preview over the columns. */
  .ctxstrip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    background: color-mix(in srgb, var(--zone) 8%, var(--card));
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    padding: 10px 16px;
    box-shadow: var(--shadow-sm);
  }
  .ctxpaper {
    flex: none;
    width: 36px;
    height: 47px;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
  }
  .ctxpaper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .ctxinfo {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ctxname {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .ctxmeta {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .ctxincipit {
    flex: 1;
    min-width: 0;
    height: 34px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 10px;
    display: flex;
    align-items: center;
    overflow: hidden;
  }
  .ctxincipit :global(svg) {
    height: 100%;
    width: auto;
    max-width: 100%;
  }
  /* A phone-width view: the strip is the piece's name and counts. */
  @container view (max-width: 700px) {
    .ctxpaper,
    .ctxincipit {
      display: none;
    }
  }
  /* The piece dots and, in a phone-width view, the board filter beside them
     (the header's own filter then hides); with many pieces the filter moves
     to its own line and the dots take the full width. */
  .boardtools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .boardtools > .seg {
    display: none;
    margin-left: auto;
    flex: none;
  }
  @container view (max-width: 700px) {
    .boardtools > .seg {
      display: inline-flex;
    }
    .hero-stats > .seg,
    .hero-stats.quiet {
      display: none;
    }
    /* The Open lane tab below carries the open count. */
    .boardtools :global(.dotlabel) {
      display: none;
    }
  }
  .ctxincnote {
    font-size: 11px;
    color: var(--ink-faint);
  }
  /* --------------------------------------------------------------- board */
  .board {
    flex: 1;
    /* Roughly a column head and one card row — the least the board is ever
       shown with, so the dock panels stop growing before crushing it. */
    min-height: 170px;
    display: flex;
    gap: 12px;
  }
  /* Lanes keep a readable width; the board never scrolls sideways, the
     stack below takes over as soon as four lanes no longer fit. */
  .board > .bcol {
    min-width: 200px;
  }
  /* A lane is the stage's colour: a solid header bar with white lettering
     over a body in the stage's wash. The three lane tokens are set per
     column key below. */
  /* Lane lettering: the theme's inverted ink on the neutral lane, white on the
     stage colours' deep tones in both themes (as on solid buttons). */
  .bcol {
    --lane-solid: var(--ink-soft);
    --lane-ink: var(--invert-ink);
    --lane-text: var(--ink-soft);
    --lane-bg: var(--bg-tint);
    --lane-line: var(--line);
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--lane-bg);
    border: 1px solid var(--lane-line);
    border-radius: 12px;
    overflow: hidden;
  }
  .bcol-head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 12px;
    background: var(--lane-solid);
    color: var(--lane-ink);
  }
  /* An empty lane: its header in the stage's text colour on the lane's wash,
     and a line saying so. */
  .bcol.empty .bcol-head {
    background: none;
    color: var(--lane-text);
    border-bottom: 1px solid var(--lane-line);
  }
  .laneempty {
    margin: 0;
    font-size: 12px;
    color: var(--ink-soft);
  }
  /* The neutral Open lane in dark: a mid slate bar, not the light ink. */
  :global([data-theme="dark"]) .bcol:not(.c-encoding, .c-validation, .c-done),
  :global([data-theme="dark"])
    .lanetab:not(.c-encoding, .c-validation, .c-done) {
    --lane-solid: var(--line-strong);
    --lane-ink: var(--ink);
  }
  .bcol-name {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .bcol-count {
    font-size: 11px;
    font-weight: 700;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 999px;
    line-height: 1;
    padding: 3px 8px;
  }
  .bcol.c-blocked {
    --lane-solid: var(--ink-faint);
    --lane-bg: var(--bg-inset);
  }
  .bcol.c-encoding,
  .lanetab.c-encoding {
    --lane-solid: var(--info-solid);
    --lane-ink: #fff;
    --lane-text: var(--info);
    --lane-bg: var(--info-bg);
    --lane-line: var(--info-line);
  }
  .bcol.c-validation,
  .lanetab.c-validation {
    --lane-solid: var(--warn-solid);
    --lane-ink: #fff;
    --lane-text: var(--warn);
    --lane-bg: var(--warn-bg);
    --lane-line: var(--warn-line);
  }
  .bcol.c-done,
  .lanetab.c-done {
    --lane-solid: var(--ok-solid);
    --lane-ink: #fff;
    --lane-text: var(--ok);
    --lane-bg: var(--ok-bg);
    --lane-line: var(--ok-line);
  }
  .well {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* Sized by its column, never by its cards: a long card list scrolls in
       here instead of growing the board — and the board's own minimum stays
       one card row, however many tasks there are. */
    contain: size;
  }
  .card {
    position: relative;
    /* A flex column, so each column's footer row (waits-for, worker,
       completion line) pins to the card's bottom edge via margin-top: auto
       instead of leaving the uniform height unused. */
    display: flex;
    flex-direction: column;
    text-align: left;
    font-family: inherit;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
    flex: none;
    /* One height for every card, whichever footer line its column gives it. */
    min-height: 88px;
    box-sizing: border-box;
  }
  /* The card the side panel shows. */
  .card.paneled {
    background: var(--info-bg);
    border-color: var(--info-line);
  }
  .card:hover {
    border-color: var(--accent);
  }
  .card.col-blocked {
    opacity: 0.8;
    box-shadow: none;
  }
  .card.col-encoding {
    border: 1.5px solid var(--info-line);
  }
  .card.col-validation {
    border: 1.5px solid var(--warn-line);
  }
  .card.col-done {
    box-shadow: none;
  }
  /* Before .card.failtint: a recorded fail outweighs the finished highlight. */
  .card.justmoved {
    border-color: var(--ok-line);
    background: var(--ok-wash);
  }
  .card.failtint {
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }
  .card.nextup {
    border-color: var(--accent);
  }
  .nextup-badge {
    position: absolute;
    top: -9px;
    left: 12px;
    background: var(--accent);
    color: var(--invert-ink);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.03em;
    line-height: 1;
    padding: 3px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .justmoved-badge {
    position: absolute;
    top: -9px;
    right: 12px;
    background: var(--ok);
    color: var(--invert-ink);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.03em;
    line-height: 1;
    padding: 3px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  :global([data-theme="dark"]) .justmoved-badge {
    color: #fff;
  }
  .card-title {
    font-size: 14px;
    line-height: 1.25;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .card-scope {
    color: var(--ink-soft);
  }
  /* The piece line, shown where several pieces share the board. A long
     title is cut to one line; the full title is its tooltip. */
  .card-piece {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--ink-soft);
  }
  .card-pname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The piece's colour, as on its dot in the piece rail. */
  .piece-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone);
  }
  .card.col-blocked .card-title,
  .card.col-done .card-title {
    color: var(--ink-soft);
  }
  .card-type {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 3px;
  }
  .boardnote {
    margin: 0;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .card-foot {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: auto;
    border-top: 1px solid var(--hairline);
    padding-top: 8px;
  }
  .card-worker {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: auto;
    padding-top: 6px;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-btn);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .worker-line {
    font-size: 11.5px;
    color: var(--info);
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A held review slot, in the review stage's colour. */
  .avatar.review {
    background: var(--warn-solid);
  }
  .worker-line.review {
    color: var(--warn);
  }
  .card-dots {
    display: flex;
    gap: 4px;
    margin-top: auto;
    padding-top: 6px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line-input);
    flex: none;
    display: inline-block;
  }
  .dot.pass {
    background: var(--green);
    border-color: var(--ok);
  }
  :global([data-theme="dark"]) .dot.pass {
    background: var(--ok);
    border-color: var(--ok-line);
  }
  .dot.fail {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
  }
  .dot.review {
    background: var(--info-bg);
    border-color: var(--info);
  }
  .card-chips {
    display: flex;
    gap: 6px;
    margin-top: 9px;
    border-top: 1px solid var(--hairline);
    padding-top: 9px;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 11px;
    font-weight: 600;
    border-radius: 999px;
    line-height: 1;
    padding: 3px 8px;
    white-space: nowrap;
  }
  .card-done {
    font-size: 11.5px;
    color: var(--ok);
    font-weight: 600;
    margin-top: auto;
    padding-top: 6px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .hand-done {
    height: 12px;
    flex: none;
  }
  /* ----------------------------------------------- manage takeover chrome */
  .crumbrow {
    flex: none;
    padding: 14px 32px 0;
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .backlink {
    font: 600 13px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    flex: none;
  }
  .backlink:hover {
    text-decoration: underline;
  }
  .bcsep {
    color: var(--line-input);
  }
  .crumbtitle {
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumbsub {
    font-size: 15px;
    color: var(--ink-faint);
    flex: none;
  }
  .ownerpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
    border-radius: 999px;
    line-height: 1;
    padding: 3px 10px;
  }
  .reapline {
    font-size: 12.5px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* --------------------------------------------------------- responsive */
  /* Measured on the board column, which the rail and the side panel narrow
     independently of the window. Four lanes need four 200px lanes with their
     borders and three 12px gaps (LANES_WIDTH); below that the lanes stack in
     one column, each as tall as its cards, and the board scrolls as a whole;
     below 420px one lane shows at a time, chosen by the lane tabs, and the
     tab replaces its head. */
  .lanetabs {
    display: none;
  }
  @container (max-width: 843px) {
    .board {
      flex-direction: column;
      min-height: 240px;
      overflow-y: auto;
    }
    .board > .bcol {
      flex: none;
      min-width: 0;
      min-height: auto;
    }
    .well {
      flex: none;
      overflow-y: visible;
      contain: none;
    }
  }
  @container (max-width: 419px) {
    .lanetabs {
      flex: none;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }
    .board {
      display: flex;
      flex-direction: column;
      min-height: 170px;
    }
    .bcol:not(.tabsel),
    .bcol-head {
      display: none;
    }
    /* One lane on a phone: cards are short rows. */
    .well {
      gap: 8px;
      padding: 8px;
    }
    .card {
      min-height: 0;
      padding: 9px 12px;
    }
  }
  .lanetab {
    --lane-solid: var(--ink-soft);
    --lane-ink: var(--invert-ink);
    --lane-text: var(--ink-soft);
    --lane-bg: var(--bg-tint);
    --lane-line: var(--line);
    min-height: 36px;
    padding: 2px 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 2px 6px;
    font: 700 12px var(--font);
    line-height: 1.15;
    text-align: center;
    color: var(--lane-text);
    background: var(--lane-bg);
    border: 1px solid var(--lane-line);
    border-radius: 10px;
    cursor: pointer;
  }
  .lanetab.on {
    color: var(--lane-ink);
    background: var(--lane-solid);
    border-color: var(--lane-solid);
  }
  .lanetab-count {
    font-size: 11px;
  }
  /* A narrow view column (a phone): the title takes one line over the
     controls (the full title is its tooltip, the repository link moves to
     the campaign details in the side panel), the controls grow to 36px, and
     the side margins shrink. */
  @container (max-width: 700px) {
    .hero {
      padding: 10px 16px 8px;
      gap: 8px;
    }
    .hero-line {
      flex-wrap: wrap;
      gap: 8px 10px;
    }
    .hero-line h1 {
      flex-basis: 100%;
      font-size: 20px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .slug {
      display: none;
    }
    .hero-line .btn {
      min-height: 36px;
    }
    /* The actions take their own full-width line, the claim the most room;
       Manage is its gear only. */
    .hero-acts {
      flex-basis: 100%;
    }
    .claimbtn {
      flex: 1;
    }
    .managechip {
      width: 36px;
      padding: 0;
      justify-content: center;
    }
    .managelabel {
      display: none;
    }
    /* The stats reduce to the attention count when there is one and the
       filter, on one plain line without the card. */
    .hero-stats {
      flex-wrap: wrap;
      gap: 6px 10px;
      padding: 0;
      background: none;
      border: 0;
      box-shadow: none;
    }
    .hero-stats .m2,
    .hbar,
    .hbarlabel {
      display: none;
    }
    .instrow {
      padding: 0 16px 14px;
    }
  }
</style>
