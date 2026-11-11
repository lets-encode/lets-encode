<!--
  The wizard's work card: the step's heading (with the info button and the
  two pane tabs when the card holds the material), the scrolling body, the
  messages pinned above the footer, and the footer (`foot`).

  The card fills the height it is given: its heading and footer stay put and
  the body scrolls between them. On its own (`.solo`, a step without
  material) it ends where its content ends. Holding the material (`shared`),
  both panes stay in the page behind the tabs, or the material takes the
  body alone when the step names no tabs. The frame's `.short` tightens it.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { markHidden } from "$lib/scroll-edges.ts";
  import { draftStatus, type WizardStepId } from "$lib/wizard.svelte.ts";

  type Tab = "form" | "material";

  let {
    step,
    heading,
    intro,
    info,
    body,
    material,
    panes,
    compactHead,
    pinned,
    shared,
    infoOpen,
    onInfo,
    noteH,
    tab = $bindable(),
    foot,
  }: {
    step: WizardStepId;
    heading: string;
    intro: string | undefined;
    info: Snippet | undefined;
    /** The step's form. */
    body: Snippet;
    material: Snippet | undefined;
    panes:
      | {
          form: string;
          material: string;
          formCount?: number;
          materialCount?: number;
          materialFirst?: boolean;
        }
      | undefined;
    compactHead: Snippet | undefined;
    pinned: Snippet | undefined;
    /** The card holds the material itself. */
    shared: boolean;
    /** The info popup is open. */
    infoOpen: boolean;
    /** Opens or closes the info popup from the info button. */
    onInfo: (e: MouseEvent) => void;
    /** The footer's reason line height, which a phone's body scrolls past. */
    noteH: number;
    /** The tab shown when the card holds the material. */
    tab: Tab;
    foot: Snippet;
  } = $props();

  // The default tab comes first.
  const tabOrder = $derived<Tab[]>(
    panes?.materialFirst ? ["material", "form"] : ["form", "material"],
  );
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

<section
  class="card"
  style:--note-h="{noteH}px"
  class:solo={!material}
  class:hug={!material}
  class:wide={!material && step === "upload"}
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
            aria-expanded={infoOpen}
            onclick={onInfo}
          >
            <Icon name="info" size={18} />
          </button>
        {/if}
      </div>
      {#if shared && panes}
        <div
          class="seg panes"
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
            {@render body()}
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
        {@render body()}
      </div>
    </div>
  {/if}

  <!-- Every step draws the frame, so the one place to report that this setup
       is no longer being kept for later — or why it opened where it did — is
       here. -->
  {#if draftStatus.resumeNotice || draftStatus.saveError || draftStatus.imagesError || pinned}
    <div class="pinned">
      {#if draftStatus.resumeNotice}
        <p class="msg-warn" role="status">{draftStatus.resumeNotice}</p>
      {/if}
      {#if draftStatus.saveError}
        <p class="msg-warn" role="status">
          This setup can't be saved in your browser, so it won't be offered for
          continuing if you leave: {draftStatus.saveError}
        </p>
      {:else if draftStatus.imagesError}
        <p class="msg-warn" role="status">
          The page images can't be kept in your browser, so continuing this
          setup later needs them uploaded again: {draftStatus.imagesError}
        </p>
      {/if}
      {@render pinned?.()}
    </div>
  {/if}

  {@render foot()}
</section>

<style>
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
  /* The two tabs (.seg, ui.css), under the heading or, in a short window,
     beside it. */
  .panes {
    flex: 1 1 100%;
    display: flex;
    margin-top: 12px;
  }
  :global(.short) .panes {
    flex: 1 1 0;
    margin-top: 0;
  }
  :global(.short) .title-row {
    flex-wrap: nowrap;
  }
  :global(.short) .card.shared h1 {
    font-size: 18px;
    white-space: nowrap;
  }
  .panes > button {
    flex: 1;
    justify-content: center;
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
  }
  /* Phones. */
  @media (max-width: 599px) {
    .card,
    .card.solo {
      --pad-x: 14px;
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
    /* Why Continue waits lies over the foot of the body (see the footer),
       which scrolls that much further. */
    .card-body {
      padding-bottom: calc(18px + var(--note-h));
    }
    .inpane :global(.material-body) {
      padding-bottom: var(--note-h);
    }
  }
  :global(.short) .card,
  :global(.short) .card.solo {
    --pad-x: 16px;
  }
  :global(.short) .card-head,
  :global(.short) .card.solo .card-head {
    padding-top: 10px;
  }

  /* A window too short to hold the heading, a usable body and the footer:
     the page scrolls as one. */
  @media (max-height: 300px) {
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
  }
</style>
