<!--
  The console's plan editor: task.csv as an editable table over the board's
  place. Only untouched tasks — unclaimed, unencoded, no verdicts — can be
  changed (dependency, score file, locator), added or removed; started tasks
  show greyed for context and can only be reordered. Saving hands the complete
  new task table to the console, which runs the savePlan command.
-->
<script lang="ts">
  import { tick } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { cardTitle } from "$lib/campaign-board.ts";
  import { taskDescription, handle } from "$lib/campaign-graph.ts";
  import type { Logins } from "$lib/campaign-graph.ts";
  import { nextTaskId, taskStarted } from "$lib/campaign-plan.ts";
  import type {
    LockRow,
    StateRow,
    TaskRow,
    ParsedState,
    PieceNames,
  } from "$lib/campaign-tables.ts";

  let {
    taskDefs,
    rows,
    validationColumns,
    locks,
    logins,
    pieceNames,
    busy,
    onsave,
    oncancel,
  }: {
    taskDefs: TaskRow[];
    rows: StateRow[];
    validationColumns: string[];
    locks: LockRow[];
    logins: Logins;
    pieceNames: PieceNames;
    busy: boolean;
    onsave: (tasks: TaskRow[]) => void;
    oncancel: () => void;
  } = $props();

  /** One task with its subtask rows — the unit the editor moves and removes. */
  interface Group {
    task: TaskRow;
    subs: TaskRow[];
    editable: boolean;
  }

  const parsedState: ParsedState = $derived({
    header: [],
    validationColumns,
    rows,
  });

  // The draft: a deep copy of the task table, grouped, taken once on entry.
  let groups = $state<Group[]>(buildDraft());
  function buildDraft(): Group[] {
    return taskDefs
      .filter((t) => t.subtask_id === "")
      .map((t) => ({
        task: { ...t },
        subs: taskDefs
          .filter((s) => s.task_id === t.task_id && s.subtask_id !== "")
          .map((s) => ({ ...s })),
        editable: !taskStarted(parsedState, locks, t.task_id),
      }));
  }

  const fragments = $derived([
    ...new Set(taskDefs.map((t) => t.fragment).filter(Boolean)),
  ]);

  /** A task's state, in the board's words. */
  const statusOf = (task: string): string => {
    const row = rows.find((r) => r.task_id === task && r.subtask_id === "");
    const lock = locks.find(
      (l) => l.task_id === task && l.subtask_id === "" && l.kind === "encoding",
    );
    if (row?.status === "completed") return "done";
    if (row?.status === "validation_required") return "review";
    if (lock) return "encoding";
    return "open";
  };
  const workerOf = (task: string): string => {
    const lock = locks.find((l) => l.task_id === task && l.kind === "encoding");
    const row = rows.find((r) => r.task_id === task && r.subtask_id === "");
    return lock
      ? handle(logins, lock.user_id)
      : row?.encoder
        ? handle(logins, row.encoder)
        : "";
  };
  const titleOf = (g: Group) =>
    g.task.fragment
      ? cardTitle(g.task.fragment, g.task.locator, pieceNames)
      : g.task.task_id;
  const sizeOf = (g: Group): string => {
    if (/^surface-\d+$/.test(g.task.locator)) return "1 page";
    if (
      g.task.locator === "measure-zones" ||
      g.task.locator === "omr-layout" ||
      g.task.locator === "encoding-align"
    )
      return "all pages";
    if (g.task.locator === "score-setup") return "score definition";
    return "whole file";
  };

  // Dependency edits keep the subtask rows aligned with their task row
  // (fragment and locator mirror it; a subtask never carries depends_on).
  function syncSubs(g: Group) {
    for (const s of g.subs) {
      s.fragment = g.task.fragment;
      s.locator = g.task.locator;
    }
  }

  function addTask() {
    const flat = groups.flatMap((g) => [g.task, ...g.subs]);
    const id = nextTaskId(flat);
    const fragment = fragments[0] ?? "sources/score.mei";
    groups = [
      ...groups,
      {
        task: {
          task_id: id,
          subtask_id: "",
          fragment,
          locator: "",
          allowlist: "",
          blocklist: "",
          depends_on: "",
        },
        subs: [
          {
            task_id: id,
            subtask_id: "S0001",
            fragment,
            locator: "",
            allowlist: "",
            blocklist: "",
            depends_on: "",
          },
        ],
        editable: true,
      },
    ];
  }

  function removeTask(index: number) {
    const removed = groups[index].task.task_id;
    groups = groups.filter((_, i) => i !== index);
    // A dependency on the removed task would be dangling — clear it.
    for (const g of groups) {
      if (g.task.depends_on === removed) g.task.depends_on = "";
    }
  }

  function moveTask(from: number, to: number) {
    const n = groups.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
    const next = [...groups];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    groups = next;
  }

  // Reordering by a task's handle: dragged, the task takes the place of each
  // row the pointer crosses. A click picks the task and a click on another
  // task's handle moves it there; the arrow keys move it by one.
  let rowList = $state<HTMLDivElement | null>(null);
  let dragging = $state<number | null>(null);
  // The picked task's id, so removing or moving a task keeps the pick.
  let picked = $state<string | null>(null);
  const pickedIndex = $derived(
    picked === null ? -1 : groups.findIndex((g) => g.task.task_id === picked),
  );
  let gesture: { x: number; y: number; moved: boolean } | null = null;
  let swallowClick = false;
  function handleDown(i: number, e: PointerEvent) {
    if (e.button !== 0) return;
    gesture = { x: e.clientX, y: e.clientY, moved: false };
    dragging = i;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function handleMove(e: PointerEvent) {
    if (!gesture || dragging === null || !rowList) return;
    if (!gesture.moved) {
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 4) return;
      gesture.moved = true;
      picked = null;
    }
    const rows = [...rowList.querySelectorAll<HTMLElement>(".prow")];
    const over = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return e.clientY >= box.top && e.clientY < box.bottom;
    });
    if (over >= 0 && over !== dragging) {
      moveTask(dragging, over);
      dragging = over;
    }
    const box = rowList.getBoundingClientRect();
    if (e.clientY < box.top + 40) rowList.scrollTop -= 10;
    else if (e.clientY > box.bottom - 40) rowList.scrollTop += 10;
  }
  function handleUp() {
    swallowClick = !!gesture?.moved;
    gesture = null;
    dragging = null;
  }
  function handleClick(i: number) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (pickedIndex < 0) picked = groups[i].task.task_id;
    else {
      moveTask(pickedIndex, i);
      picked = null;
    }
  }
  async function handleKey(i: number, e: KeyboardEvent) {
    const to =
      e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : null;
    if (e.key === "Escape") picked = null;
    if (to === null || to < 0 || to >= groups.length) return;
    e.preventDefault();
    moveTask(i, to);
    await tick();
    rowList?.querySelectorAll<HTMLElement>(".grip")[to]?.focus();
  }
  const handleTitle = (i: number) =>
    pickedIndex < 0
      ? "Drag to move this task. Or click it, then click the task whose place it takes. The arrow keys move it up and down."
      : pickedIndex === i
        ? "Click again to leave this task where it is."
        : `Click to move task ${picked} here.`;

  const save = () => onsave(groups.flatMap((g) => [g.task, ...g.subs]));
</script>

<div class="plan">
  <div class="phead">
    <span class="plabel"
      >Task plan <span class="countpill">{groups.length}</span></span
    >
    <span class="pmode">● Editing the plan</span>
    <span class="pnote">Changes only touch tasks nobody has worked on yet.</span
    >
    <span class="pspacer"></span>
    <button type="button" class="btn" onclick={addTask} disabled={busy}
      ><Icon name="plus" />Add task</button
    >
    <button type="button" class="btn" onclick={oncancel} disabled={busy}
      >Cancel</button
    >
    <button type="button" class="btn btn-primary" onclick={save} disabled={busy}
      >Save the plan</button
    >
  </div>
  <div class="prow phrow">
    <span></span><span>Task</span><span>Type</span><span>Size</span><span
      >Depends on</span
    ><span>Status</span><span></span>
  </div>
  <div class="pbody" bind:this={rowList}>
    {#each groups as g, i (g.task.task_id)}
      {@const status = statusOf(g.task.task_id)}
      <div
        class="prow"
        class:locked={!g.editable}
        class:dragged={dragging === i && pickedIndex < 0}
        class:picked={pickedIndex === i}
        role="row"
        tabindex="-1"
      >
        <button
          type="button"
          class="grip"
          class:target={pickedIndex >= 0 && pickedIndex !== i}
          aria-label={`Task ${g.task.task_id}: move`}
          aria-pressed={pickedIndex === i}
          title={handleTitle(i)}
          onpointerdown={(e) => handleDown(i, e)}
          onpointermove={handleMove}
          onpointerup={handleUp}
          onpointercancel={handleUp}
          onclick={() => handleClick(i)}
          onkeydown={(e) => handleKey(i, e)}><Icon name="grip" /></button
        >
        <div class="pcell-task">
          {#if g.editable}
            <div class="ptitle">{titleOf(g)}</div>
            <div class="psub">
              <select
                class="pselect"
                bind:value={g.task.fragment}
                onchange={() => syncSubs(g)}
                aria-label="Score file"
              >
                {#each fragments as fr (fr)}
                  <option value={fr}
                    >{pieceNames[fr] ? `${pieceNames[fr]} — ${fr}` : fr}</option
                  >
                {/each}
                {#if !fragments.includes(g.task.fragment)}
                  <option value={g.task.fragment}>{g.task.fragment}</option>
                {/if}
              </select>
              <input
                class="pinput mono"
                bind:value={g.task.locator}
                oninput={() => syncSubs(g)}
                placeholder="whole file"
                aria-label="Locator (empty = whole file, or surface-N)"
                title="Which part of the file the task addresses: empty for the whole file, surface-N for one page."
              />
            </div>
          {:else}
            <div class="ptitle">
              {titleOf(g)}
            </div>
            <div class="psub muted">
              <span class="mono">{g.task.task_id}</span>
              {#if workerOf(g.task.task_id)}
                · locked while {workerOf(g.task.task_id)} works on it
              {/if}
            </div>
          {/if}
        </div>
        <span class="ptype">{taskDescription(g.task.locator)}</span>
        <span class="psize"
          >{sizeOf(g)}{#if !g.editable}<span class="lockmark">
              · locked</span
            >{/if}</span
        >
        <div class="pdep">
          {#if g.editable}
            <select
              class="pselect"
              bind:value={g.task.depends_on}
              aria-label="Depends on"
            >
              <option value="">—</option>
              {#each groups as other (other.task.task_id)}
                {#if other.task.task_id !== g.task.task_id}
                  <option value={other.task.task_id}
                    >{titleOf(other)} ({other.task.task_id})</option
                  >
                {/if}
              {/each}
            </select>
          {:else}
            <span class="muted"
              >{g.task.depends_on
                ? groups.find((o) => o.task.task_id === g.task.depends_on)
                  ? titleOf(
                      groups.find((o) => o.task.task_id === g.task.depends_on)!,
                    )
                  : g.task.depends_on
                : "—"}</span
            >
          {/if}
        </div>
        <span class="chip pstatus">{status}</span>
        <span class="pact">
          {#if g.editable}
            <button
              type="button"
              class="btn btn-icon btn-danger"
              aria-label="Remove task"
              title="Remove this task"
              onclick={() => removeTask(i)}
              disabled={busy}><Icon name="trash" /></button
            >
          {/if}
        </span>
      </div>
    {/each}
    <div class="pfoot">
      Completed and claimed tasks are shown greyed and cannot be edited; they
      free up when their claim is released.
    </div>
  </div>
</div>

<style>
  .plan {
    flex: 1;
    min-height: 0;
    margin: 0 32px 16px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .phead {
    height: 48px;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 10px;
  }
  .plabel {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }
  .pmode {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
    border-radius: 999px;
    line-height: 1;
    padding: 4px 10px;
  }
  .pnote {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .pspacer {
    flex: 1;
  }
  .prow {
    display: grid;
    grid-template-columns: 28px minmax(200px, 1fr) 150px 110px 250px 130px 80px;
    gap: 12px;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--bg-tint);
  }
  .phrow {
    background: var(--bg-alt);
    border-bottom: 1px solid var(--line);
    padding: 8px 16px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }
  .pbody {
    flex: 1;
    overflow: auto;
  }
  .prow.locked {
    opacity: 0.65;
  }
  .prow.dragged {
    background: var(--accent-tint-strong);
    box-shadow: 0 2px 8px rgba(31, 36, 51, 0.14);
  }
  .prow.picked {
    background: var(--accent-tint-strong);
    outline: 1.5px solid var(--accent);
  }
  .prow .grip {
    justify-self: center;
  }
  .ptitle {
    font-size: 13.5px;
    font-weight: 600;
  }
  .psub {
    display: flex;
    gap: 6px;
    margin-top: 4px;
    align-items: center;
  }
  .psub.muted,
  .muted {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .mono {
    font-family: ui-monospace, Menlo, monospace;
  }
  .pselect,
  .pinput {
    font: 400 11.5px var(--font);
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line-input);
    border-radius: 6px;
    padding: 3px 6px;
    min-width: 0;
  }
  .pselect {
    max-width: 210px;
  }
  .pinput {
    width: 90px;
  }
  .ptype,
  .psize {
    font-size: 12px;
    color: var(--ink-soft);
  }
  .lockmark {
    color: var(--ink-faint);
  }
  .pstatus {
    justify-self: start;
  }
  .pact {
    text-align: right;
  }
  .pfoot {
    padding: 10px 16px;
    font-size: 12px;
    color: var(--ink-faint);
  }
</style>
