<!--
  A pre-task editor's task box: TaskBox on the editor's session, with the
  editor's own controls below the status row and the review commands run
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
    prefill,
    measures = true,
  }: {
    session: PreTaskSession;
    campaign: string;
    card: BoardCard;
    /** The editor's own controls. */
    tools: Snippet;
    /** The anchor a fresh fail form opens with. */
    prefill: () => { page: string; m1: string; m2: string };
    /** The fail form asks for a measure range besides the page. */
    measures?: boolean;
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
  {prefill}
  {measures}
  onclaim={(_, sub) => session.claimValidation(sub)}
  onabandon={(_, sub) => session.abandon(sub)}
  onvalidate={(_, sub, verdict, comment) =>
    session.validate(sub, verdict, comment)}
  onreviewedit={(_, sub, comment) => session.reviewEdit(sub, comment)}
/>
