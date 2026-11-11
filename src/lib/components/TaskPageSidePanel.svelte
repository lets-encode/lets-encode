<!--
  The side panel of the full-screen task views (review, zones, score setup):
  derives the colour slot of the task's piece from the campaign tables and
  renders SidePanel on the task, with the view's task box pinned on top. The
  view is the task's own, so the panel has no Campaign state. A view passing
  tools, a selection or a footer gets the score-workspace panel (SidePanel).
-->
<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CampaignTables, Result } from "$lib/commands.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { findRow, pieceZone } from "$lib/campaign-tables.ts";
  import type { SidePanelState } from "$lib/side-panels.ts";
  import SidePanel from "./SidePanel.svelte";

  type PanelTables = Pick<
    CampaignTables,
    "taskDefs" | "comments" | "logins" | "canPush"
  >;

  let {
    repoId,
    tables,
    taskId,
    viewer,
    runner,
    panel = $bindable(),
    minWidth,
    review = false,
    done = false,
    composerHint = "",
    taskBox,
    tools,
    selection,
    selectionLabel,
    selectionActive = false,
    selected = null,
    tab = $bindable("selection"),
    compose,
    footer,
    bar,
    open = $bindable(false),
    onanchor,
    oncomment,
    onresolve,
  }: {
    /** The campaign's repository id; task ids repeat across campaigns. */
    repoId: number;
    tables: PanelTables;
    /** The task the view is open on. */
    taskId: string;
    viewer: string;
    runner: CommandRunner;
    panel: SidePanelState;
    /** The narrowest the panel gets beside the view (SidePanel). */
    minWidth?: number;
    /** The task awaits review: comments take the review colour. */
    review?: boolean;
    /** The task is done: its change requests read as history. */
    done?: boolean;
    /** Composer placeholder override (e.g. when a measure is selected). */
    composerHint?: string;
    /** The task's record and controls, pinned above the comments; given the
        panel's Comments button for its heading (SidePanel). */
    taskBox: Snippet<[Snippet | undefined]>;
    /** The view's task tools, below the task box. */
    tools?: Snippet;
    /** The selected item's controls, as a tab beside the comments. */
    selection?: Snippet;
    selectionLabel?: string;
    /** Something is selected (SidePanel). */
    selectionActive?: boolean;
    /** The selected item: each new one shows the selection tab. */
    selected?: unknown;
    tab?: "selection" | "comments";
    /** Each change opens the comment field (SidePanel). */
    compose?: number;
    /** The task's action, pinned to the panel's bottom. */
    footer?: Snippet;
    /** Docked as a sheet: a row at the sheet's top (SidePanel). */
    bar?: Snippet;
    /** Docked: whether the panel is opened (SidePanel). */
    open?: boolean;
    /** Show a comment's measure range in the view's own viewer; absent hides the action. */
    onanchor?: (comment: CommentRow) => void;
    oncomment: (
      task: string,
      kind: string,
      body: string,
      parent_id: string,
    ) => Promise<Result | null>;
    onresolve: (comment_id: string) => Promise<unknown>;
  } = $props();

  $effect(() => {
    if (selected) untrack(() => (tab = "selection"));
  });

  // The pieces the tasks address, in the campaign page's order, so the colour
  // slot matches the piece's tint there.
  const paths = $derived([
    ...new Set(
      tables.taskDefs
        .filter((t) => t.subtask_id === "" && t.fragment)
        .map((t) => t.fragment),
    ),
  ]);
  const fragment = $derived(
    findRow(tables.taskDefs, taskId, "")?.fragment ?? "",
  );
  const index = $derived(Math.max(0, paths.indexOf(fragment)));
</script>

<SidePanel
  task={taskId}
  {repoId}
  zone={pieceZone(index)}
  {review}
  {done}
  comments={tables.comments}
  logins={tables.logins}
  {viewer}
  canPush={tables.canPush}
  {runner}
  bind:panel
  {minWidth}
  inScore
  {composerHint}
  {taskBox}
  {tools}
  {selection}
  {selectionLabel}
  {selectionActive}
  bind:tab
  {compose}
  {footer}
  {bar}
  bind:open
  sheet={!!(tools || selection || footer)}
  {onanchor}
  oncomment={(kind, body, parent_id) =>
    oncomment(taskId, kind, body, parent_id)}
  {onresolve}
/>
