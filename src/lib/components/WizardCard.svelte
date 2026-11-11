<!--
  The wizard's shared frame: the step navigation, the work card, and for steps
  with material (pages, XML) the material pane. This file arranges the parts
  and holds the layout rules that tie them together; the parts are in
  components/wizard/.

  Navigation is the vertical step rail (WizardRail) on wide or landscape
  windows and the horizontal step track (WizardTrack) above the card otherwise
  (wizard-layout.svelte.ts). A window 500px tall or less gets the compact rail.
  Both are derived from the wizard store: completed steps show a one-line
  summary of what they collected and navigate back on click; upcoming steps
  are disabled; steps with nothing to do for this campaign are left out.

  The work card (WizardWorkCard) fills the height it is given: its heading and
  footer stay put and the body scrolls between them, so the step's primary
  action is always in view. Messages a step pins (an error, a progress log) sit
  between the body and the footer. A step without material gets its card on
  its own, ending where its content ends.

  A step with material lays it out in one of three ways: the material pane in
  the centre with the card on the right, the material pane above the card, or —
  on phones and narrow windows — both inside the card behind a two-tab switch
  (or the material alone when the step names no tabs), with the intro behind an
  info button. The first two share one layout, so changing between them keeps
  the material pane as it is.

  The footer (WizardFooter) is built from the handlers a step passes, so the
  buttons are written once. A step whose controls do not fit that shape — the
  name step, whose Continue submits a form — passes its own `footer` snippet
  instead and styles the buttons with the shared .btn classes.
-->
<script module lang="ts">
  import type { WizardStepId } from "$lib/wizard.svelte.ts";

  // The work card's width and the stacked material pane's share of the height
  // once dragged, module-level so a drag survives moving between steps: each
  // step mounts its own instance of this frame. Until then the card takes its
  // fluid default width and the pane its step's default share.
  let workWidth = $state<number | null>(null);
  const stackShare = $state<Partial<Record<WizardStepId, number>>>({});
  const DEFAULT_SHARE: Partial<Record<WizardStepId, number>> = {
    pages: 0.64,
    pieces: 0.56,
    source: 0.38,
    preparation: 0.34,
  };
</script>

<script lang="ts">
  import PaneDivider from "$lib/components/PaneDivider.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { untrack, type Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import { auth } from "$lib/auth.svelte.ts";
  import DiscardSetupConfirm from "$lib/components/DiscardSetupConfirm.svelte";
  import WizardRail from "$lib/components/wizard/WizardRail.svelte";
  import WizardTrack from "$lib/components/wizard/WizardTrack.svelte";
  import WizardWorkCard from "$lib/components/wizard/WizardWorkCard.svelte";
  import WizardFooter from "$lib/components/wizard/WizardFooter.svelte";
  import WizardPopup from "$lib/components/wizard/WizardPopup.svelte";
  import { wizardLayout } from "$lib/wizard-layout.svelte.ts";
  import { stepSummaries } from "$lib/wizard/step-summaries.ts";
  import { popupStyle, type PopupKind } from "$lib/wizard/popup-place.ts";
  import { OtherDrafts, SavedClock } from "$lib/wizard/frame-drafts.svelte.ts";
  import {
    WIZARD_STEPS,
    discardSetup,
    isSkipped,
    piecesSummary,
    registeredNote,
    resetWizard,
    stepIndex,
    wizard,
  } from "$lib/wizard.svelte.ts";

  let {
    step,
    heading,
    intro,
    info,
    children,
    material,
    panes,
    compactHead,
    pinned,
    status,
    onBack,
    onNext,
    nextLabel = "Continue",
    nextIcon = "arrow-right",
    nextDisabled = false,
    nextReason,
    footnote,
    backDisabled = false,
    navBlocked,
    finish = false,
    footer,
  }: {
    step: WizardStepId;
    heading: string;
    /** Optional one-line explanation shown under the heading. */
    intro?: string;
    /** Shown after the intro when it sits behind the info button. */
    info?: Snippet;
    children: Snippet;
    /** The step's content for the material pane, filling it. */
    material?: Snippet;
    /**
     * The two tabs that switch between the card's content and the material
     * when both share the card. Without them the material takes the card's
     * body alone there.
     */
    panes?: {
      form: string;
      material: string;
      formCount?: number;
      materialCount?: number;
      /** Open on the material tab rather than the form. */
      materialFirst?: boolean;
    };
    /** Under the heading when the material takes the card's body alone. */
    compactHead?: Snippet;
    /** Between the body and the footer, outside the scrolling body. */
    pinned?: Snippet;
    /** What the step is doing right now, shown under its rail entry. */
    status?: string;
    /** Omitted on the first step, which has nothing to go back to. */
    onBack?: () => void;
    onNext?: () => void;
    nextLabel?: string;
    /** The icon after the next label; null for none. */
    nextIcon?: "arrow-right" | "check" | null;
    nextDisabled?: boolean;
    /**
     * Why Next is disabled, linked to the button as its description. Shown
     * above the footer, or at the top of the form tab when the material is
     * behind the other tab, with the button's tooltip repeating it.
     */
    nextReason?: string;
    /** A control on the footer's row left of the buttons, in place of the reason. */
    footnote?: Snippet;
    /** A step's work is under way: Back, Discard and the other setups wait. */
    backDisabled?: boolean;
    /**
     * Why the step cannot be left right now: disables Back, Next and the
     * rail's steps, with this as their tooltip.
     */
    navBlocked?: string;
    /** Styles the primary button green, for the step that completes the flow. */
    finish?: boolean;
    /** Controls the Back/Next pair cannot express, in place of it. */
    footer?: Snippet;
  } = $props();
  const reasonId = $props.id();
  // The reason's height; on a phone it lies over the body, which scrolls
  // that much further.
  let noteH = $state(0);

  const sidebar = $derived(wizardLayout.sidebar);
  const short = $derived(wizardLayout.short);
  const mode = $derived(wizardLayout.materialMode);
  // The card holds the material itself.
  const shared = $derived(!!material && mode === "switch");

  // Whether a step is skipped follows from the upload, so steps are left out
  // only once the upload step is done; before that the whole flow is listed.
  const steps = $derived(
    WIZARD_STEPS.filter(
      (s) => !(isSkipped(s.id) && stepIndex(step) > stepIndex("upload")),
    ),
  );
  const current = $derived(steps.findIndex((s) => s.id === step));

  // One-line summaries for the rail's completed steps, read from the store.
  const summaries = $derived(stepSummaries(wizard, piecesSummary()));

  // What a step shows under its label: the current step's status, a
  // completed step's summary.
  function valueOf(i: number, id: WizardStepId): string {
    if (i === current) return status ?? "";
    return i < current ? summaries[id] : "";
  }

  const clock = new SavedClock();
  const others = new OtherDrafts();

  // The divider resizes the work card (side by side) or the material pane
  // (stacked); the other takes whatever is left. The card's width is in
  // pixels so the choice survives a window resize; both are clamped so the
  // two stay usable.
  let area = $state<HTMLDivElement>();
  let workW = $state(0);
  let winW = $state(0);

  // Discarding asks once before it lets go of everything collected. A setup
  // whose name is registered is a reachable campaign: it can only be finished.
  let confirmingDiscard = $state(false);
  const registered = $derived(wizard.claim?.registered === true);
  const registeredTitle = $derived(
    registered && wizard.claim ? registeredNote(wizard.claim.name) : undefined,
  );
  function discardThisSetup() {
    confirmingDiscard = false;
    // The draft goes at once; the name is given back while the page moves
    // to the campaign list.
    void discardSetup(auth.user?.login, wizard.handle.trim(), wizard.claim);
    resetWizard();
    void goto("/campaigns");
  }

  // The other setups behind a disclosure, the intro behind the info button,
  // and in the compact rail the discard question open as popups. They are
  // placed against the window, so the rail's and the card's clipping does not
  // cut them off. One is open at a time. They close on Escape, on a press
  // outside them and when the window changes size; the inline discard question
  // closes on Escape and on a press outside it.
  let popup = $state<{ kind: PopupKind; style: string } | null>(null);
  function togglePopup(kind: PopupKind, e: MouseEvent, width: number) {
    if (popup?.kind === kind) {
      popup = null;
      return;
    }
    const anchor = e.currentTarget as HTMLElement;
    const besideRail = sidebar && short;
    const style = popupStyle({
      kind,
      anchor: anchor.getBoundingClientRect(),
      rail:
        besideRail && kind !== "info"
          ? (anchor.closest(".rail")?.getBoundingClientRect() ?? null)
          : null,
      width,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      besideRail,
    });
    confirmingDiscard = false;
    popup = { kind, style };
  }
  function toggleDiscard() {
    popup = null;
    confirmingDiscard = !confirmingDiscard;
  }
  function closePopups() {
    popup = null;
    confirmingDiscard = false;
  }
  function onWindowPointerDown(e: PointerEvent) {
    if (!(e.target as Element).closest?.("[data-popup]")) closePopups();
  }

  // The tab shown when the card holds the material; a step's default tab is
  // read once, when the step opens.
  let tab = $state<"form" | "material">(
    untrack(() => panes?.materialFirst) ? "material" : "form",
  );
</script>

<svelte:window
  bind:innerWidth={winW}
  onpointerdown={onWindowPointerDown}
  onkeydown={(e) => e.key === "Escape" && closePopups()}
  onresize={() => (popup = null)}
/>

<div class="workbench" class:sidebar class:short>
  {#if sidebar}
    <WizardRail
      {steps}
      {current}
      {valueOf}
      {short}
      savedAgo={clock.ago}
      {backDisabled}
      {navBlocked}
      {confirmingDiscard}
      {registered}
      {registeredTitle}
      otherDrafts={others.list}
      resuming={others.resuming}
      resumeError={others.error}
      onResume={(handle) => others.resume(handle)}
      onDiscard={() => (confirmingDiscard = true)}
      links={popupLinks}
      {discardQuestion}
    />
  {:else}
    <WizardTrack
      {steps}
      {current}
      {valueOf}
      {status}
      savedAgo={clock.ago}
      {backDisabled}
      {navBlocked}
      {confirmingDiscard}
      links={popupLinks}
      {discardQuestion}
    />
  {/if}

  <div class="area" class:stacked={mode === "stacked"} bind:this={area}>
    {#if material && mode !== "switch"}
      <div
        class="material"
        style={mode === "stacked"
          ? `flex-basis: ${(stackShare[step] ?? DEFAULT_SHARE[step] ?? 0.5) * 100}%`
          : undefined}
      >
        {@render material()}
      </div>

      {#if mode === "stacked"}
        <PaneDivider
          label="Resize the material pane"
          vertical={false}
          bind:value={
            () => stackShare[step] ?? DEFAULT_SHARE[step] ?? 0.5,
            (v) => (stackShare[step] = v)
          }
          min={0.2}
          max={0.8}
          step={0.05}
          fraction
          at={(e) => {
            const box = area!.getBoundingClientRect();
            return (e.clientY - box.top) / box.height;
          }}
        />
      {:else}
        <!-- The card is anchored to the right: it grows as the divider
             moves left. -->
        <PaneDivider
          label="Resize the work card"
          bind:value={() => workWidth ?? workW, (v) => (workWidth = v)}
          min={380}
          max={Math.min(860, winW * 0.65)}
          step={24}
          reverse
          at={(e) => window.innerWidth - e.clientX}
        />
      {/if}

      <div
        class="work"
        bind:clientWidth={workW}
        style={workWidth === null || mode === "stacked"
          ? undefined
          : `--work-width: ${workWidth}px`}
      >
        {@render workCard()}
      </div>
    {:else}
      <div class="stage" class:hug={!material}>
        {@render workCard()}
      </div>
    {/if}
  </div>

  {#if popup}
    <WizardPopup
      kind={popup.kind}
      style={popup.style}
      otherDrafts={others.list}
      resuming={others.resuming}
      resumeError={others.error}
      onResume={(handle) => others.resume(handle)}
      {backDisabled}
      {discardQuestion}
      {intro}
      {info}
    />
  {/if}
</div>

<!-- The other setups and Discard, behind a disclosure and a popup where the
     rail or the track has no room to list them. -->
{#snippet popupLinks(discardLabel: string)}
  {#if others.list.length}
    <button
      type="button"
      class="btn others"
      data-popup
      aria-expanded={popup?.kind === "others"}
      onclick={(e) => togglePopup("others", e, 320)}
    >
      {others.list.length} other setup{others.list.length === 1 ? "" : "s"}
      <Icon name="chevron-down" size={12} />
    </button>
  {/if}
  {#if auth.user}
    {@const asPopup = sidebar && short}
    {@const open = asPopup ? popup?.kind === "discard" : confirmingDiscard}
    <button
      type="button"
      class="btn btn-danger"
      data-popup
      aria-expanded={open}
      onclick={(e) =>
        asPopup ? togglePopup("discard", e, 260) : toggleDiscard()}
      disabled={backDisabled || registered}
      title={registeredTitle}
    >
      <Icon name="trash" />{discardLabel}
    </button>
  {/if}
{/snippet}

{#snippet discardQuestion()}
  <DiscardSetupConfirm
    repo={wizard.repo}
    onconfirm={discardThisSetup}
    oncancel={closePopups}
    disabled={backDisabled}
  />
{/snippet}

{#snippet workCard()}
  <WizardWorkCard
    {step}
    {heading}
    {intro}
    {info}
    body={children}
    {material}
    {panes}
    {compactHead}
    {pinned}
    {shared}
    infoOpen={popup?.kind === "info"}
    onInfo={(e) => togglePopup("info", e, 320)}
    {noteH}
    bind:tab
  >
    {#snippet foot()}
      <WizardFooter
        {footer}
        {footnote}
        hasMaterial={!!material}
        {reasonId}
        {nextReason}
        {nextDisabled}
        {onBack}
        {onNext}
        {nextLabel}
        {nextIcon}
        {backDisabled}
        {navBlocked}
        {finish}
        bind:noteH
      />
    {/snippet}
  </WizardWorkCard>
{/snippet}

<style>
  .workbench {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(60% 90% at 15% 0%, var(--glow-blue), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, var(--glow-green), transparent 60%),
      var(--bg-alt);
  }
  .workbench.sidebar {
    flex-direction: row;
  }

  /* ---- Area: material pane, divider, work card --------------------------- */
  .area {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
  }
  .area.stacked {
    flex-direction: column;
    padding: 6px 16px 16px;
  }
  .material {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    margin: 24px 0 24px 12px;
  }
  .stacked .material {
    flex: 0 0 50%;
    margin: 0;
  }
  /* The divider between the material pane and the work card (.pane-grip in
     ui.css); stacked, it lies across. */
  .stacked :global(.pane-grip) {
    width: auto;
    height: 22px;
    cursor: ns-resize;
  }
  .stacked :global(.pane-grip)::before {
    width: 2.8rem;
    height: 4px;
    background: var(--line-strong);
  }
  .work {
    flex: none;
    width: var(
      --work-width,
      max(clamp(340px, 25.6vw + 78px, 472px), min(30vw, 680px))
    );
    box-sizing: border-box;
    padding: 24px 24px 24px 3px;
    display: flex;
  }
  .stacked .work {
    flex: 1;
    width: auto;
    min-height: 0;
    padding: 0;
  }

  /* ---- Stage: the card on its own ---------------------------------------- */
  /* In the rail layout a short card centres in the area, sitting a little above
     the vertical middle. The offset comes from unequal spacers rather than
     padding, so it gives way to nothing when space is short. Under the track
     the card starts at the top. */
  .stage {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    box-sizing: border-box;
    padding: 8px 24px;
  }
  .sidebar .stage.hug::before,
  .sidebar .stage.hug::after {
    content: "";
    flex: 2 1 0;
  }
  .sidebar .stage.hug::after {
    flex-grow: 3;
  }
  .workbench:not(.sidebar) .stage {
    padding: 6px 16px 16px;
  }
  .short .stage {
    padding: 8px 12px 8px 4px;
  }

  /* ---- Smaller windows ---------------------------------------------------- */
  @media (max-width: 599px) {
    .workbench:not(.sidebar) .stage {
      padding: 0 12px 12px;
    }
  }

  /* A window too short to hold the heading, a usable body and the footer:
     the page scrolls as one, with the footer held at the bottom edge. */
  @media (max-height: 300px) {
    .workbench {
      overflow: auto;
    }
    .workbench.sidebar {
      align-items: flex-start;
    }
    .workbench:not(.sidebar) .area {
      flex: none;
    }
    .area,
    .stage {
      min-height: auto;
    }
  }
</style>
