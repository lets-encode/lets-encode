<!--
  A pre-task editor's task box: TaskBox on the editor's session, with the
  editor's own controls below the status row and the claim commands run
  through the session.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import TaskBox from "./TaskBox.svelte";

  let {
    session,
    campaign,
    card,
    tools,
    headAction,
  }: {
    session: PreTaskSession;
    campaign: string;
    card: BoardCard;
    /** The editor's own controls, below the status row. */
    tools?: Snippet;
    /** A control at the heading's right end (TaskBox). */
    headAction?: Snippet;
  } = $props();
  const tables = $derived(session.tables!);
</script>

<TaskBox
  {card}
  pieceName={card.piece}
  {campaign}
  locks={session.locks}
  rows={tables.rows}
  logins={tables.logins}
  viewer={session.viewer}
  canPush={tables.canPush}
  runner={session.runner}
  inView
  {tools}
  {headAction}
  onclaim={(_, sub) => session.claimValidation(sub)}
  onabandon={(_, sub) => session.abandon(sub)}
/>
