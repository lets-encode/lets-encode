<!--
  The wizard's shared frame: the step navigation, the work card, and for steps
  with material (pages, XML) the material pane.

  Navigation is the vertical step rail on wide or landscape windows and the
  horizontal step track above the card otherwise (wizard-layout.svelte.ts). A
  window 500px tall or less gets the compact rail. Both are derived from the
  wizard store: completed steps show a one-line summary of what they collected
  and navigate back on click; upcoming steps are disabled; steps with nothing to
  do for this campaign are left out.

  The work card fills the height it is given: its heading and footer stay put
  and the body scrolls between them, so the step's primary action is always in
  view. Messages a step pins (an error, a progress log) sit between the body and
  the footer. A step without material gets its card on its own, ending where
  its content ends.

  A step with material lays it out in one of three ways: the material pane in
  the centre with the card on the right, the material pane above the card, or —
  on phones and narrow windows — both inside the card behind a two-tab switch
  (or the material alone when the step names no tabs), with the intro behind an
  info button. The first two share one layout, so changing between them keeps
  the material pane as it is.

  The footer is built here from the handlers a step passes, so the buttons are
  written once. A step whose controls do not fit that shape — the name step,
  whose Continue submits a form — passes its own `footer` snippet instead and
  styles the buttons with the shared .btn classes.
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
  import Icon from "$lib/components/Icon.svelte";
  import { untrack, type Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import { auth } from "$lib/auth.svelte.ts";
  import { licenseById } from "$lib/licenses.ts";
  import { releaseClaim } from "$lib/campaign-resolve.ts";
  import { discardDraft, resumableDrafts } from "$lib/wizard-draft.ts";
  import { wizardLayout } from "$lib/wizard-layout.svelte.ts";
  import {
    WIZARD_STEPS,
    draftSnapshot,
    draftStatus,
    isSkipped,
    piecesSummary,
    resetWizard,
    resumeDraft,
    saveDraft,
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
     * Why Next is disabled, shown above the footer beside the button and
     * linked to it as its description.
     */
    nextReason?: string;
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
  const reasonShown = $derived(nextDisabled && !!nextReason);

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
  const uploadSummary = $derived.by(() => {
    const parts: string[] = [];
    const pdfs = wizard.files.filter((f) => /\.pdf$/i.test(f.name)).length;
    const others = wizard.files.length - pdfs;
    if (pdfs) parts.push(`${pdfs} PDF${pdfs === 1 ? "" : "s"}`);
    if (others) parts.push(`${others} file${others === 1 ? "" : "s"}`);
    if (wizard.iiifManifestUrl.trim()) parts.push("IIIF manifest");
    if (wizard.candidates.length)
      parts.push(`${wizard.candidates.length} pages`);
    else if (!parts.length && wizard.encodings.length)
      parts.push(
        `${wizard.encodings.length} encoding${wizard.encodings.length === 1 ? "" : "s"}`,
      );
    return parts.join(" · ") || "no material";
  });

  const sourceSummary = $derived.by(() => {
    const imprint = [wizard.source.publisher, wizard.source.date]
      .filter(Boolean)
      .join(", ");
    return [wizard.source.title, imprint].filter(Boolean).join(" · ");
  });

  const summaries = $derived<Record<WizardStepId, string>>({
    name: [wizard.handle, wizard.title].filter((s) => s.trim()).join(" · "),
    license: licenseById(wizard.license).name.split(" — ")[0],
    upload: uploadSummary,
    pages: wizard.images.length
      ? `${wizard.images.length} kept`
      : wizard.repo
        ? "no pages"
        : "",
    source: sourceSummary,
    pieces: piecesSummary(),
    preparation: "",
  });

  // What a step shows under its label: the current step's status, a
  // completed step's summary.
  function valueOf(i: number, id: WizardStepId): string {
    if (i === current) return status ?? "";
    return i < current ? summaries[id] : "";
  }

  // "Draft saved · just now": a clock that only needs to be roughly right, so
  // it ticks well below the minute it reports in.
  let now = $state(Date.now());
  $effect(() => {
    if (draftStatus.savedAt === null) return;
    const clock = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(clock);
  });
  const savedAgo = $derived.by(() => {
    if (draftStatus.savedAt === null) return null;
    const minutes = Math.floor((now - draftStatus.savedAt) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ago`;
  });

  // Other setups of this account stored in the browser, listed so one of them
  // can be picked up from here. Read again after each save of this one, since a
  // save is when the stored set changes.
  const otherDrafts = $derived.by(() => {
    draftStatus.savedAt;
    const owner = auth.user?.login;
    if (!owner) return [];
    const handle = wizard.handle.trim();
    return resumableDrafts(owner).filter((d) => d.handle !== handle);
  });
  let resuming = $state<string | null>(null);
  let resumeError = $state<string | null>(null);

  async function resumeOther(handle: string) {
    if (resuming) return;
    resumeError = null;
    resuming = handle;
    // The setup being left is saved on a debounce; write it now so its last
    // edits are kept.
    const owner = auth.user?.login;
    if (owner) saveDraft(owner, draftSnapshot());
    try {
      await resumeDraft(handle);
    } catch (err) {
      resumeError = `Could not resume “${handle}”: ${(err as Error).message}`;
    }
    resuming = null;
  }

  // Dragging the divider resizes the work card (side by side) or the
  // material pane (stacked); the other takes whatever is left. The card's
  // width is in pixels so the choice survives a window resize; both are
  // clamped so the two stay usable.
  let area = $state<HTMLDivElement>();
  let resizing = false;
  function startResize(e: PointerEvent) {
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (!resizing) return;
    if (mode === "stacked") {
      if (!area) return;
      const box = area.getBoundingClientRect();
      stackShare[step] = Math.min(
        Math.max((e.clientY - box.top) / box.height, 0.2),
        0.8,
      );
      return;
    }
    // The card is anchored to the right, so it grows as the pointer moves left.
    workWidth = Math.min(
      Math.max(window.innerWidth - e.clientX, 380),
      Math.min(860, window.innerWidth * 0.65),
    );
  }
  function endResize(e: PointerEvent) {
    resizing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  // Discarding asks once before it lets go of everything collected.
  let confirmingDiscard = $state(false);
  function discardSetup() {
    const handle = wizard.handle.trim();
    const claim = wizard.claim;
    confirmingDiscard = false;
    if (handle) discardDraft(handle);
    resetWizard();
    // Give the name back so it is free again straight away. Best-effort: an
    // unreleased hold runs out on its own.
    if (claim) void releaseClaim(claim.name, claim.token);
    void goto("/campaigns");
  }

  // The other setups behind a disclosure, the intro behind the info button,
  // and in the compact rail the discard question open as popups. They are
  // placed against the window, so the rail's and the card's clipping does not
  // cut them off. One is open at a time. They close on Escape, on a press
  // outside them and when the window changes size; the inline discard question
  // closes on Escape and on a press outside it.
  type PopupKind = "others" | "discard" | "info";
  let popup = $state<{ kind: PopupKind; style: string } | null>(null);
  function togglePopup(kind: PopupKind, e: MouseEvent, width: number) {
    if (popup?.kind === kind) {
      popup = null;
      return;
    }
    const anchor = e.currentTarget as HTMLElement;
    const box = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const w = Math.min(width, vw - 16);
    let place: string;
    if (sidebar && short && kind !== "info") {
      // Beside the compact rail, level with the link's foot.
      const rail = anchor.closest(".rail")?.getBoundingClientRect() ?? box;
      place = `left: ${rail.right + 8}px; bottom: ${window.innerHeight - box.bottom}px`;
    } else {
      const start = kind === "info" ? box.left - 8 : box.right - w;
      const left = Math.max(8, Math.min(start, vw - w - 8));
      place = `left: ${left}px; top: ${box.bottom + 4}px`;
    }
    confirmingDiscard = false;
    popup = { kind, style: `${place}; width: ${w}px` };
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
  // The default tab comes first.
  const tabOrder = $derived<("form" | "material")[]>(
    panes?.materialFirst ? ["material", "form"] : ["form", "material"],
  );
  // Marks a scrolling body's wrapper with data-more-above / data-more-below
  // while content lies above or below what is in view, which shows a fade at
  // that edge. Read again on scroll and whenever the body or anything in it
  // changes size.
  function markHidden(body: HTMLElement) {
    const update = () => {
      const wrap = body.parentElement;
      wrap?.toggleAttribute("data-more-above", body.scrollTop > 1);
      wrap?.toggleAttribute(
        "data-more-below",
        body.scrollHeight - body.scrollTop - body.clientHeight > 1,
      );
    };
    const sizes = new ResizeObserver(update);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(body);
      for (const child of body.children) sizes.observe(child);
      update();
    };
    const content = new MutationObserver(watch);
    content.observe(body, { childList: true });
    body.addEventListener("scroll", update, { passive: true });
    watch();
    return () => {
      sizes.disconnect();
      content.disconnect();
      body.removeEventListener("scroll", update);
    };
  }

  function onTabKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    tab = tab === "form" ? "material" : "form";
    const tabs = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      "[role=tab]",
    );
    tabs[tabOrder.indexOf(tab)]?.focus();
  }
</script>

<svelte:window
  onpointerdown={onWindowPointerDown}
  onkeydown={(e) => e.key === "Escape" && closePopups()}
  onresize={() => (popup = null)}
/>

<div class="workbench" class:sidebar class:short>
  {#if sidebar}
    <nav class="rail" aria-label="Campaign setup steps">
      <div class="rail-name">
        {#if wizard.handle.trim()}
          {wizard.handle}
          {#if auth.user}
            <span class="rail-slug">{auth.user.login}/{wizard.handle}</span>
          {/if}
        {:else}
          <span class="rail-unnamed">Unnamed campaign</span>
        {/if}
      </div>
      {#if savedAgo}
        <div class="saved rail-saved-top">
          <span class="saved-dot"></span>Saved · {savedAgo}
        </div>
      {/if}

      <ol class="steps">
        {#each steps as s, i (s.id)}
          {@const done = i < current}
          {@const active = i === current}
          {@const value = valueOf(i, s.id)}
          <li>
            <button
              type="button"
              class="step"
              disabled={!done || backDisabled || navBlocked !== undefined}
              title={done ? navBlocked : undefined}
              onclick={() => (wizard.step = s.id)}
              aria-current={active ? "step" : undefined}
            >
              <span class="rail-chain">
                <span class="bubble" class:done class:active>
                  {#if done}<Icon name="check" size={12} />{:else}{i + 1}{/if}
                </span>
                {#if i < steps.length - 1}
                  <span
                    class="connector"
                    class:done
                    class:tolive={i === current - 1}
                  ></span>
                {/if}
              </span>
              <span class="step-text">
                <span
                  class="step-label"
                  class:active
                  class:upcoming={!done && !active}
                >
                  {s.label}
                </span>
                <!-- The compact rail has the campaign name on top already. -->
                {#if value && !(short && s.id === "name")}
                  <span class={active ? "step-status" : "step-summary"}
                    >{value}</span
                  >
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ol>

      <div class="rail-foot">
        {#if savedAgo && !short}
          <div class="saved">
            <span class="saved-dot"></span>Draft saved · {savedAgo}
          </div>
        {/if}
        {#if short}
          {@render popupLinks("Discard this setup")}
        {:else}
          {#if auth.user}
            {#if confirmingDiscard}
              <div class="discard-inline" data-popup>
                {@render discardQuestion()}
              </div>
            {:else}
              <button
                type="button"
                class="linkbtn"
                onclick={() => (confirmingDiscard = true)}
              >
                Discard this setup
              </button>
            {/if}
          {/if}
          {#each otherDrafts as draft (draft.handle)}
            <button
              type="button"
              class="linkbtn other-draft"
              onclick={() => resumeOther(draft.handle)}
              disabled={resuming !== null}
            >
              {resuming === draft.handle
                ? "Working…"
                : `Resume setup of “${draft.entries?.title?.trim() || draft.handle}”`}
            </button>
          {/each}
          {#if resumeError}
            <p class="msg-error" role="alert">{resumeError}</p>
          {/if}
        {/if}
      </div>
    </nav>
  {:else}
    <div class="trackbar">
      <div class="thead">
        {#if wizard.handle.trim()}
          <span class="tname">{wizard.handle}</span>
          {#if auth.user}
            <span class="tslug">{auth.user.login}/{wizard.handle}</span>
          {/if}
        {:else}
          <span class="tname rail-unnamed">Unnamed campaign</span>
        {/if}
        <span class="push"></span>
        {#if savedAgo}
          <span class="saved thead-saved">
            <span class="saved-dot"></span>Saved · {savedAgo}
          </span>
        {/if}
        {@render popupLinks("Discard setup")}
      </div>
      {#if confirmingDiscard}
        <div class="discard-strip" data-popup>
          {@render discardQuestion()}
        </div>
      {/if}

      <nav class="track" aria-label="Campaign setup steps">
        <div class="track-steps" style="--n: {steps.length}">
          <span class="line" aria-hidden="true"></span>
          {#if current > 0}
            <span
              class="line done"
              aria-hidden="true"
              style="width: calc((100% - 100% / var(--n)) * {current} / {steps.length -
                1})"
            ></span>
          {/if}
          <ol>
            {#each steps as s, i (s.id)}
              {@const done = i < current}
              {@const active = i === current}
              {@const value = valueOf(i, s.id)}
              <li>
                <button
                  type="button"
                  class="tstep"
                  class:active
                  disabled={!done || backDisabled || navBlocked !== undefined}
                  title={(done && navBlocked) || value || undefined}
                  aria-label={s.label}
                  onclick={() => (wizard.step = s.id)}
                  aria-current={active ? "step" : undefined}
                >
                  <span class="hit">
                    <span class="bubble" class:done class:active>
                      {#if done}<Icon name="check" size={12} />{:else}{i +
                          1}{/if}
                    </span>
                  </span>
                  <span
                    class="step-label"
                    class:active
                    class:upcoming={!done && !active}>{s.label}</span
                  >
                  {#if value}
                    <span class={active ? "step-status" : "step-summary"}
                      >{value}</span
                    >
                  {/if}
                </button>
              </li>
            {/each}
          </ol>
        </div>
      </nav>

      <!-- Below 600px the track shows circles only; this line names the
           current step instead. -->
      <div class="tcur">
        <b>{steps[current]?.label}</b>
        {#if status}<span class="step-status">{status}</span>{/if}
        {#if savedAgo}
          <span class="push saved">
            <span class="saved-dot"></span>Saved · {savedAgo}
          </span>
        {/if}
      </div>
    </div>
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

      <div
        class="grip"
        role="separator"
        aria-label={mode === "stacked"
          ? "Resize the material pane"
          : "Resize the work card"}
        aria-orientation={mode === "stacked" ? "horizontal" : "vertical"}
        onpointerdown={startResize}
        onpointermove={onResize}
        onpointerup={endResize}
        onpointercancel={endResize}
      ></div>

      <div
        class="work"
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
    <div class="popup {popup.kind}-popup" style={popup.style} data-popup>
      {#if popup.kind === "others"}
        <div class="popup-head">Other setups on this account</div>
        {#each otherDrafts as draft (draft.handle)}
          <button
            type="button"
            class="resume"
            onclick={() => resumeOther(draft.handle)}
            disabled={resuming !== null}
          >
            <span class="resume-text">
              {resuming === draft.handle
                ? "Working…"
                : `Resume setup of “${draft.entries?.title?.trim() || draft.handle}”`}
            </span>
          </button>
        {/each}
        {#if resumeError}
          <p class="msg-error" role="alert">{resumeError}</p>
        {/if}
      {:else if popup.kind === "discard"}
        {@render discardQuestion()}
      {:else}
        {#if intro}<p>{intro}</p>{/if}
        {@render info?.()}
      {/if}
    </div>
  {/if}
</div>

<!-- The other setups and Discard, behind a disclosure and a popup where the
     rail or the track has no room to list them. -->
{#snippet popupLinks(discardLabel: string)}
  {#if otherDrafts.length}
    <button
      type="button"
      class="linkbtn others"
      data-popup
      aria-expanded={popup?.kind === "others"}
      onclick={(e) => togglePopup("others", e, 320)}
    >
      {otherDrafts.length} other setup{otherDrafts.length === 1 ? "" : "s"}
      <Icon name="chevron-down" size={12} />
    </button>
  {/if}
  {#if auth.user}
    {@const asPopup = sidebar && short}
    {@const open = asPopup ? popup?.kind === "discard" : confirmingDiscard}
    <button
      type="button"
      class="linkbtn"
      class:danger={open}
      data-popup
      aria-expanded={open}
      onclick={(e) =>
        asPopup ? togglePopup("discard", e, 260) : toggleDiscard()}
    >
      {discardLabel}
    </button>
  {/if}
{/snippet}

{#snippet discardQuestion()}
  <span>Discard everything entered so far?</span>
  <span class="discard-row">
    <button type="button" class="btn btn-danger" onclick={discardSetup}>
      Discard for good
    </button>
    <button type="button" class="btn" onclick={closePopups}>Keep it</button>
  </span>
{/snippet}

{#snippet workCard()}
  {@const solo = !material}
  <section
    class="card"
    class:solo
    class:hug={solo}
    class:wide={solo && step === "upload"}
    class:shared
    aria-label={heading}
  >
    <div class="card-head">
      <div class="title-row">
        <div class="headline">
          <h1>{heading}</h1>
          {#if shared && (intro || info)}
            <button
              type="button"
              class="info"
              data-popup
              aria-label="About this step"
              aria-expanded={popup?.kind === "info"}
              onclick={(e) => togglePopup("info", e, 320)}
            >
              <Icon name="info" size={18} />
            </button>
          {/if}
        </div>
        {#if shared && panes}
          <div
            class="panes"
            role="tablist"
            aria-label="Pane"
            tabindex="-1"
            onkeydown={onTabKey}
          >
            {#each tabOrder as id (id)}
              {@const count =
                id === "form" ? panes.formCount : panes.materialCount}
              <button
                type="button"
                role="tab"
                id="wizard-tab-{id}"
                aria-controls="wizard-pane-{id}"
                aria-selected={tab === id}
                tabindex={tab === id ? 0 : -1}
                class:on={tab === id}
                onclick={() => (tab = id)}
              >
                {id === "form" ? panes.form : panes.material}
                {#if count !== undefined}<span class="n">{count}</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      {#if intro && !shared}<p class="intro">{intro}</p>{/if}
      {#if shared && !panes}{@render compactHead?.()}{/if}
    </div>

    {#if shared}
      <div class="panes-body">
        {#if panes}
          <div
            class="body-wrap pane"
            class:off={tab !== "form"}
            inert={tab !== "form"}
            role="tabpanel"
            id="wizard-pane-form"
            aria-labelledby="wizard-tab-form"
          >
            <div class="card-body" {@attach markHidden}>
              {@render children()}
            </div>
          </div>
        {/if}
        <div
          class="inpane pane"
          class:off={!!panes && tab !== "material"}
          inert={!!panes && tab !== "material"}
          role={panes ? "tabpanel" : undefined}
          id={panes ? "wizard-pane-material" : undefined}
          aria-labelledby={panes ? "wizard-tab-material" : undefined}
        >
          {@render material?.()}
        </div>
      </div>
    {:else}
      <div class="body-wrap">
        <div class="card-body" {@attach markHidden}>
          {@render children()}
        </div>
      </div>
    {/if}

    <!-- Every step draws the frame, so the one place to report that this setup
         is no longer being kept for later — or why it opened where it did — is
         here. -->
    {#if draftStatus.resumeNotice || draftStatus.saveError || pinned || reasonShown}
      <div class="pinned">
        {#if draftStatus.resumeNotice}
          <p class="msg-warn" role="status">{draftStatus.resumeNotice}</p>
        {/if}
        {#if draftStatus.saveError}
          <p class="msg-warn" role="status">
            This setup can't be saved in your browser, so it won't be offered
            for continuing if you leave: {draftStatus.saveError}
          </p>
        {/if}
        {@render pinned?.()}
        {#if reasonShown}
          <p class="msg-warn" id={reasonId} role="status">{nextReason}</p>
        {/if}
      </div>
    {/if}

    <div class="footer">
      {#if footer}
        {@render footer()}
      {:else}
        {#if onBack}
          <button
            type="button"
            class="btn btn-lg btn-secondary"
            onclick={onBack}
            disabled={backDisabled || navBlocked !== undefined}
            title={navBlocked}
          >
            Back
          </button>
        {/if}
        {#if onNext}
          <button
            type="button"
            class="btn btn-lg btn-primary"
            class:btn-finish={finish}
            onclick={onNext}
            disabled={nextDisabled || navBlocked !== undefined}
            title={navBlocked}
            aria-describedby={reasonShown ? reasonId : undefined}
          >
            {nextLabel}{#if nextIcon}<Icon name={nextIcon} />{/if}
          </button>
        {/if}
      {/if}
    </div>
  </section>
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

  /* ---- Shared bits: bubbles, labels, saved line, link buttons ----------- */
  .bubble {
    box-sizing: border-box;
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12.5px;
    background: var(--card);
    border: 1px solid var(--line-strong);
    color: var(--ink-faint);
    position: relative;
    z-index: 1;
  }
  .bubble.done {
    font-size: 13px;
    background: var(--ok-btn);
    border: none;
    color: #fff;
  }
  .bubble.active {
    font-weight: 600;
    background: var(--accent-btn);
    border: none;
    color: #fff;
    box-shadow: 0 0 0 4px rgba(37, 99, 201, 0.15);
  }
  .step-label {
    display: block;
    font-size: 13.5px;
    font-weight: 600;
    line-height: 16px;
    color: var(--ink-soft);
  }
  .step-label.active {
    color: var(--ink);
  }
  .step-label.upcoming {
    color: var(--ink-faint);
  }
  .step-summary,
  .step-status {
    display: block;
    font-size: 11.5px;
    line-height: 15px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .step-status {
    color: var(--accent);
    font-weight: 600;
  }
  .saved {
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .saved-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
  }
  .rail-unnamed {
    color: var(--ink-faint);
  }
  .linkbtn {
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
    font: 12px var(--font);
    padding: 0;
    color: var(--ink-faint);
    background: none;
    border: none;
    text-decoration: underline;
    text-align: left;
  }
  .linkbtn.danger {
    color: var(--danger);
  }
  .linkbtn.others {
    color: var(--link);
    text-decoration: none;
  }
  @media (hover: hover) {
    .linkbtn:hover {
      color: var(--danger);
    }
    .linkbtn.others:hover,
    .linkbtn.other-draft:hover {
      color: var(--accent);
    }
  }
  @media (pointer: coarse) {
    .linkbtn {
      min-height: 44px;
    }
    /* In the line above the track the press area overlaps its neighbours
       rather than making the line taller. */
    .thead .linkbtn {
      margin-block: -10px;
    }
  }
  .discard-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .discard-row .btn {
    min-height: 40px;
  }

  /* ---- Popups ------------------------------------------------------------ */
  .popup {
    position: fixed;
    z-index: 30;
    box-sizing: border-box;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 8px;
  }
  .discard-popup {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--ink);
    background: var(--danger-wash);
    border-color: var(--danger-line);
  }
  .info-popup {
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--ink-soft);
  }
  .info-popup p {
    margin: 0;
  }
  .info-popup :global(ul) {
    margin: 8px 0 0;
    padding: 0;
  }
  .popup-head {
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-faint);
    padding: 6px 8px 4px;
  }
  .resume {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 44px;
    padding: 0 10px;
    border: none;
    background: none;
    border-radius: 8px;
    font: 13px var(--font);
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  .resume-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (hover: hover) {
    .resume:hover:not(:disabled) {
      background: var(--accent-tint);
    }
  }
  .popup .msg-error {
    margin: 6px 4px 2px;
  }

  /* ---- Step rail --------------------------------------------------------- */
  .rail {
    flex: none;
    width: 248px;
    box-sizing: border-box;
    padding: 24px 20px 18px;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  /* Below 1300px the rail gives the page images part of its width. */
  @media (max-width: 1299px) {
    .rail {
      width: 208px;
      padding-inline: 16px;
    }
  }
  .rail-name {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    margin: 2px 0 16px;
    overflow-wrap: anywhere;
  }
  .rail-slug {
    display: block;
    margin-top: 2px;
    font:
      400 12px ui-monospace,
      Menlo,
      monospace;
    color: var(--ink-faint);
  }
  .rail-saved-top {
    display: none;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .step {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    width: 100%;
    padding: 0;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .step:disabled {
    cursor: default;
  }
  .rail-chain {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: none;
  }
  .connector {
    width: 2px;
    height: 20px;
    border-radius: 1px;
    background: var(--line-strong);
  }
  /* The chain colours in as the steps complete: green along the completed
     stretch, blending into blue where it reaches the active step. */
  .connector.done {
    background: var(--ok-btn);
  }
  .connector.tolive {
    background: linear-gradient(var(--ok-btn), var(--accent-btn));
  }
  .step-text {
    display: block;
    flex: 1;
    padding-top: 5px;
    min-width: 0;
  }
  .rail .step-summary,
  .rail .step-status {
    max-width: 180px;
  }
  .rail-foot {
    margin-top: auto;
    padding-top: 14px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .discard-inline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .other-draft {
    margin-top: 4px;
  }

  /* A window 500px tall or less: a narrow rail with the name and the saved
     line on top, and Discard pinned to the foot. */
  .short .rail {
    width: 156px;
    padding: 8px 6px 6px 12px;
  }
  .short .rail-slug {
    display: none;
  }
  .short .rail-name {
    font-size: 13px;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .short .rail-saved-top {
    display: flex;
    margin: 2px 0 6px;
  }
  .short .bubble {
    width: 24px;
    height: 24px;
    font-size: 11.5px;
  }
  .short .connector {
    height: 4px;
  }
  .short .step-text {
    padding-top: 4px;
  }
  .short .step-label {
    font-size: 13px;
  }
  .short .rail .step-summary,
  .short .rail .step-status {
    font-size: 11px;
    line-height: 13px;
    max-width: 118px;
  }
  .short .rail-foot {
    padding-top: 4px;
  }

  /* ---- Step track -------------------------------------------------------- */
  .trackbar {
    flex: none;
  }
  .thead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px 0;
    min-height: 30px;
    font-size: 13px;
    color: var(--ink-faint);
  }
  .tname {
    font-weight: 600;
    color: var(--ink);
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .tslug {
    font:
      12px ui-monospace,
      Menlo,
      monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .push {
    margin-left: auto;
  }
  .discard-strip {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 6px 12px 2px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--ink);
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
    border-radius: 10px;
  }
  .track {
    margin: 6px 16px 0;
  }
  .track-steps {
    position: relative;
  }
  .track ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
  }
  /* The connecting line runs between the first and the last bubble's
     centres; its completed part ends at the current step. */
  .line {
    position: absolute;
    top: 21px;
    height: 2px;
    left: calc(100% / (var(--n) * 2));
    right: calc(100% / (var(--n) * 2));
    background: var(--line-strong);
  }
  .line.done {
    right: auto;
    background: linear-gradient(
      90deg,
      var(--ok-btn) calc(100% - 30px),
      var(--accent-btn)
    );
  }
  .track li {
    min-width: 0;
  }
  .tstep {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 0;
    padding: 0 2px;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    text-align: center;
    cursor: pointer;
  }
  .tstep:disabled {
    cursor: default;
  }
  .hit {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tstep .bubble {
    width: 24px;
    height: 24px;
    font-size: 11.5px;
  }
  .tstep .bubble.active {
    box-shadow: 0 0 0 3px rgba(37, 99, 201, 0.15);
  }
  .tstep .step-label {
    margin-top: -6px;
    font-size: 12px;
    line-height: 14px;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tstep .step-summary,
  .tstep .step-status {
    max-width: 100%;
    font-size: 10.5px;
    line-height: 13px;
  }
  /* 600–799px: labels, and the current step's status; from 800px the
     completed steps' values too. */
  @media (max-width: 799px) {
    .tstep .step-summary {
      display: none;
    }
  }
  .tcur {
    display: none;
  }
  /* Below 600px: circles only, with the current step's name, status and
     saved line on one line under the track. */
  @media (max-width: 599px) {
    .thead {
      min-height: 34px;
      padding-top: 4px;
    }
    .tslug,
    .thead-saved {
      display: none;
    }
    /* The circles sit as far below the name as the name sits below the top
       bar; their 44px press areas overlap the line above. */
    .track {
      margin-top: -6px;
    }
    .tstep .step-label,
    .tstep .step-status {
      display: none;
    }
    .tcur {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-height: 22px;
      padding: 0 20px;
      font-size: 13px;
    }
    .tcur b {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
    }
    .tcur .step-status {
      font-size: 13px;
      min-width: 0;
    }
    .tcur .saved {
      font-size: 12px;
    }
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
  /* The divider between the material pane and the work card: a grab bar with
     a centred handle. */
  .grip {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    cursor: ew-resize;
    touch-action: none;
  }
  .grip::before {
    content: "";
    width: 3px;
    height: 2.5rem;
    border-radius: 999px;
    background: var(--line);
  }
  .stacked .grip {
    width: auto;
    height: 22px;
    cursor: ns-resize;
  }
  .stacked .grip::before {
    width: 2.8rem;
    height: 4px;
    background: var(--line-strong);
  }
  @media (hover: hover) {
    .grip:hover::before {
      background: var(--accent);
    }
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

  /* ---- Work card ---------------------------------------------------------- */
  .card {
    flex: 1;
    min-width: 0;
    min-height: 0;
    align-self: stretch;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    box-sizing: border-box;
    --pad-x: 28px;
  }
  .card.solo {
    width: 680px;
    max-width: 100%;
    align-self: center;
    --pad-x: 42px;
  }
  /* The upload step's card, sized for the dropzone. */
  .card.wide {
    width: 920px;
  }
  /* A card on its own ends where its content ends, up to the height it is
     given. */
  .card.hug {
    flex: 0 1 auto;
  }
  .card-head {
    flex: none;
    padding: 26px var(--pad-x) 0;
  }
  .card.solo .card-head {
    padding-top: 36px;
  }
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 14px;
  }
  /* The heading with its info button beside it, outside the heading so the
     button's label is not read as part of it. */
  .headline {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 21px;
    line-height: 1.25;
    font-weight: 600;
  }
  .card.solo h1 {
    font-size: 26px;
    line-height: 1.2;
  }
  .intro {
    margin: 8px 0 0;
    font-size: 13.5px;
    color: var(--ink-soft);
  }
  .card.solo .intro {
    margin-top: 9px;
    font-size: 14px;
  }
  .info {
    flex: none;
    width: 44px;
    height: 44px;
    margin: -10px -10px -10px -4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: none;
    border: none;
    color: var(--ink-faint);
    cursor: pointer;
  }
  /* The two tabs, under the heading or, in a short window, beside it. */
  .panes {
    flex: 1 1 100%;
    display: flex;
    gap: 2px;
    margin-top: 12px;
    padding: 2px;
    background: var(--bg-tint);
    border-radius: 999px;
  }
  .short .panes {
    flex: 1 1 0;
    margin-top: 0;
  }
  .short .title-row {
    flex-wrap: nowrap;
  }
  .short .card.shared h1 {
    font-size: 18px;
    white-space: nowrap;
  }
  .panes button {
    flex: 1;
    min-height: 30px;
    border: none;
    background: transparent;
    border-radius: 999px;
    font: 600 13px var(--font);
    color: var(--ink-soft);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .panes button.on {
    background: var(--card);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.12);
  }
  .panes .n {
    font-weight: 400;
    color: var(--ink-faint);
  }

  /* The body takes what the heading and footer leave and scrolls within it,
     with a fade at the top or the foot while there is more in that
     direction. */
  .body-wrap {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .card.hug .body-wrap {
    flex: 0 1 auto;
  }
  .body-wrap::before,
  .body-wrap::after {
    content: "";
    position: absolute;
    z-index: 1;
    left: 0;
    right: 0;
    height: 26px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .body-wrap::before {
    top: 0;
    background: linear-gradient(var(--card), transparent);
  }
  .body-wrap::after {
    bottom: 0;
    background: linear-gradient(transparent, var(--card));
  }
  .body-wrap:global([data-more-above])::before,
  .body-wrap:global([data-more-below])::after {
    opacity: 1;
  }
  /* A field focused near either edge scrolls clear of the 26px fades. */
  .card-body {
    scroll-padding-block: 26px;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    padding: 0 var(--pad-x) 18px;
  }
  /* 16px: below that, iOS zooms into a field when it gets focus. */
  .card.solo .card-body :global(.input) {
    font-size: 16px;
    padding: 11px 14px;
  }

  /* The card holding the material: both panes stay in the page, the hidden
     one keeping its size and scroll position. */
  .panes-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    margin-top: 10px;
  }
  .pane {
    grid-area: 1 / 1;
    min-height: 0;
  }
  .pane.off {
    visibility: hidden;
  }
  .panes-body .card-body {
    padding-top: 6px;
  }
  .inpane {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--line);
  }
  .inpane :global(.material-card) {
    border: none;
    border-radius: 0;
    box-shadow: none;
  }

  .pinned {
    flex: none;
    padding: 0 var(--pad-x);
  }
  /* Space between the last message and the footer's divider. */
  .pinned > :global(:last-child) {
    margin-bottom: 10px;
  }
  .pinned :global(.msg-error),
  .pinned :global(.msg-warn) {
    margin: 10px 0 0;
  }
  .pinned > :global(.log) {
    margin-top: 10px;
    max-height: 30vh;
  }

  .footer {
    flex: none;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding: 14px var(--pad-x) 18px;
    border-top: 1px solid var(--line);
  }
  .card.solo .footer {
    margin-top: 18px;
  }

  /* ---- Smaller windows ---------------------------------------------------- */
  @media (max-width: 999px) {
    .card {
      --pad-x: 18px;
    }
    .card.solo {
      --pad-x: 24px;
    }
    .card-head,
    .card.solo .card-head {
      padding-top: 16px;
    }
    .footer,
    .card.solo .footer {
      margin-top: 0;
      padding-top: 12px;
      padding-bottom: 14px;
    }
  }
  /* Phones: the primary button takes the row's width, and a step's own line
     beside the buttons (an acknowledgement) moves above them. */
  @media (max-width: 599px) {
    .card,
    .card.solo {
      --pad-x: 14px;
    }
    .workbench:not(.sidebar) .stage {
      padding: 0 12px 12px;
    }
    .card-head {
      padding-top: 10px;
    }
    .card.solo .card-head {
      padding-top: 14px;
    }
    .panes {
      margin-top: 8px;
    }
    .panes-body {
      margin-top: 8px;
    }
    .footer,
    .card.solo .footer {
      padding-top: 10px;
      padding-bottom: 12px;
    }
    .footer {
      flex-wrap: wrap;
    }
    .footer > :global(*:not(.btn)) {
      flex: 1 1 100%;
    }
    .footer > :global(.btn-primary) {
      flex: 1;
    }
  }
  .short .card,
  .short .card.solo {
    --pad-x: 16px;
  }
  .short .card-head,
  .short .card.solo .card-head {
    padding-top: 10px;
  }
  .short .footer,
  .short .card.solo .footer {
    padding-top: 8px;
    padding-bottom: 10px;
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
    .card {
      flex: none;
      min-height: auto;
      overflow: visible;
    }
    .body-wrap,
    .card-body {
      flex: none;
      overflow: visible;
    }
    .panes-body {
      flex: none;
      height: 240px;
    }
    .footer {
      position: sticky;
      bottom: 0;
      background: var(--card);
      border-radius: 0 0 14px 14px;
    }
  }
</style>
