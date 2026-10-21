<!--
  The under-construction notice. On the campaign listing and the wizard a
  dialog opens until this browser has confirmed it, and the banner shows once
  it has; every other page shows the banner. The banner's Details link opens
  the same dialog. Only "I understand" marks
  the notice as seen; Escape or a click outside closes it for this visit.
  The banner's close button hides it for the browser session.
-->
<script lang="ts">
  import { tick } from "svelte";
  import { page } from "$app/state";
  import Icon from "./Icon.svelte";
  import { bugReportHref } from "$lib/bug-report.ts";

  const SEEN_KEY = "construction-notice-seen";
  const CLOSED_KEY = "construction-banner-closed";

  let dialog = $state<HTMLDialogElement>();
  const withDialog = $derived(
    page.route.id === "/campaigns" || page.route.id === "/new",
  );

  const reportHref = $derived(bugReportHref(page.url.pathname));

  function seen(): boolean {
    try {
      return localStorage.getItem(SEEN_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  let confirmed = $state(seen());

  function readClosed(): boolean {
    try {
      return sessionStorage.getItem(CLOSED_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  let closed = $state(readClosed());

  function closeBanner() {
    try {
      sessionStorage.setItem(CLOSED_KEY, "1");
    } catch (e) {
      /* storage unavailable — the banner shows again on the next page load */
    }
    closed = true;
  }

  function open() {
    if (dialog && !dialog.open) dialog.showModal();
  }

  function confirm() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch (e) {
      /* storage unavailable — the dialog opens again on the next visit */
    }
    confirmed = true;
    dialog?.close();
  }

  $effect(() => {
    if (withDialog && !confirmed) open();
  });

  // Surfaces fixed below the top bar offset themselves by the banner's
  // current height, read as --notice-h.
  const withBanner = $derived((!withDialog || confirmed) && !closed);
  let bannerHeight = $state(0);

  // The banner keeps to one line: where its text does not fit, it gives the
  // short sentence (level 1), then drops the bug report link (2), then the
  // sentence (3). It refits whenever the banner's width changes.
  let level = $state(0);
  let textEl = $state<HTMLElement>();
  async function fit() {
    level = 0;
    await tick();
    while (level < 3 && textEl && textEl.scrollWidth > textEl.clientWidth) {
      level++;
      await tick();
    }
  }
  function oneLine(el: HTMLElement) {
    let width = -1;
    fit();
    const ro = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }
  $effect(() => {
    document.documentElement.style.setProperty(
      "--notice-h",
      `${withBanner ? bannerHeight : 0}px`,
    );
  });
</script>

{#if withBanner}
  <div
    class="banner"
    role="note"
    bind:offsetHeight={bannerHeight}
    {@attach oneLine}
  >
    <Icon name="warning" size={16} />
    <span class="banner-text" bind:this={textEl}
      ><strong>Under construction.</strong>
      {#if level === 0}
        Data on this platform can be reset at any time. GitHub repositories
        created with the platform are kept, but the platform may no longer open
        them.
      {:else if level < 3}
        Data on this platform can be reset at any time.
      {/if}
      <span class="banner-links">
        <button type="button" class="link" onclick={open}>Details</button>
        {#if level < 2}
          <a href={reportHref} target="_blank" rel="noopener">Report a bug</a>
        {/if}
      </span></span
    >
    <button
      type="button"
      class="close"
      aria-label="Hide this notice until the browser is closed"
      title="Hide this notice until the browser is closed"
      onclick={closeBanner}><Icon name="close" size={14} /></button
    >
  </div>
{/if}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  aria-labelledby="construction-title"
  onclick={(e) => {
    if (e.target === dialog) dialog.close();
  }}
>
  <div class="sheet">
    <div class="stripe" aria-hidden="true">
      <span></span><span></span><span></span>
    </div>
    <div class="content">
      <div class="head">
        <span class="tag"><Icon name="warning" size={13} /> Test version</span>
        <h2 id="construction-title">This site is under construction</h2>
      </div>
      <p class="intro">
        Let's Encode! is a citizen-science project that helps anyone turn sheet
        music into machine-readable encodings in the MEI format. On this
        platform you can start an encoding campaign for a collection of scores
        or join an existing one: volunteers encode the pieces, other volunteers
        check them, and every campaign is stored in its own GitHub repository.
      </p>
      <ul class="points">
        <li>
          <span class="pi pi-blue"><Icon name="check-circle" size={20} /></span>
          <span
            >You can try out every feature. Report bugs and feedback with the <strong
              >Report a bug</strong
            > button.</span
          >
        </li>
        <li>
          <span class="pi pi-orange"><Icon name="reset" size={20} /></span>
          <span
            >Campaigns and all other data on this platform can be reset at any
            time. We do not guarantee that campaigns are kept.</span
          >
        </li>
        <li>
          <span class="pi pi-green"><Icon name="lock" size={20} /></span>
          <span
            >GitHub repositories created with the platform stay in your GitHub
            account and are not affected by a reset, but after a reset the
            platform may no longer show or open them.</span
          >
        </li>
      </ul>
      <div class="actions">
        <a class="about" href="/" target="_blank" rel="noopener"
          >About Let's Encode! <Icon
            name="external"
            size={13}
            label="opens in a new tab"
          /></a
        >
        <div class="buttons">
          <a class="btn" href={reportHref} target="_blank" rel="noopener"
            >Report a bug</a
          >
          <button type="button" class="btn btn-primary" onclick={confirm}
            >I understand</button
          >
        </div>
      </div>
    </div>
  </div>
</dialog>

<style>
  .banner {
    flex: none;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: 8px;
    padding: 9px 20px;
    background: var(--warn-bg);
    /* A strip across the window: none of the shared .banner card's rounding,
       side borders or shadow. */
    border-radius: 0;
    border-width: 0 0 1px;
    border-style: solid;
    border-color: var(--warn-line);
    box-shadow: none;
    font-size: 13.5px;
    line-height: 1.4;
    color: var(--ink);
  }
  .banner > :global(.icon) {
    color: var(--warn);
    margin-top: 1px;
  }
  .banner strong {
    font-weight: 600;
  }
  /* One line (oneLine); the padding keeps the links' 24px press inside the
     clipped box. */
  .banner-text {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding-block: 3px;
    margin-block: -3px;
  }
  /* 32px to tap, without growing the banner. */
  .close {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin: -6px -8px -6px 0;
    padding: 0;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--ink-soft);
    cursor: pointer;
  }
  @media (hover: hover) {
    .close:hover {
      color: var(--ink);
      background: color-mix(in srgb, var(--warn) 12%, transparent);
    }
  }
  .banner-links {
    display: inline-flex;
    gap: 16px;
    margin-left: 12px;
    white-space: nowrap;
  }
  /* Phones: tighter and smaller. */
  @media (max-width: 560px) {
    .banner {
      padding: 6px 12px;
      font-size: 12.5px;
      align-items: center;
    }
    .banner-links {
      margin-left: 8px;
    }
  }
  /* A short window (a phone in landscape): the notice takes the footer's
     place at the bottom as one line, and the layout hides the footer. */
  @media (max-height: 500px) {
    .banner {
      order: 1;
      padding: 5px 12px;
      font-size: 12.5px;
      align-items: center;
      border-bottom: 0;
      border-top: 1px solid var(--warn-line);
    }
  }
  .banner-links a,
  .link {
    font: inherit;
    font-weight: 600;
    color: var(--warn);
    text-decoration: underline;
    background: none;
    border: none;
    /* 24px tall to tap, without growing the banner. */
    padding: 3px 0;
    margin: -3px 0;
    cursor: pointer;
  }

  dialog {
    width: 600px;
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 32px);
    padding: 0;
    border: none;
    border-radius: 16px;
    background: var(--card);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  dialog::backdrop {
    background: rgba(35, 40, 56, 0.48);
  }
  .stripe {
    display: flex;
    height: 6px;
  }
  .stripe span {
    flex: 1;
    background: var(--blue);
  }
  .stripe span:nth-child(2) {
    background: var(--green);
  }
  .stripe span:nth-child(3) {
    background: #ffa76d;
  }
  .content {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 36px 40px 32px;
  }
  .head {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    color: var(--warn);
    font-size: 13px;
    font-weight: 600;
  }
  h2 {
    margin: 0;
    font-size: 28px;
    line-height: 1.2;
    font-weight: 600;
  }
  .intro {
    margin: 0;
    font-size: 16px;
    line-height: 1.55;
    color: var(--ink-soft);
  }
  .points {
    list-style: none;
    margin: 0;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    border-radius: 12px;
    background: var(--bg-alt);
    font-size: 15px;
    line-height: 1.5;
  }
  .points li {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .points strong {
    font-weight: 600;
  }
  .pi {
    display: inline-flex;
    margin-top: 1px;
  }
  .pi-blue {
    color: var(--accent);
  }
  .pi-orange {
    color: var(--warn);
  }
  .pi-green {
    color: var(--ok);
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    padding-top: 4px;
  }
  .about {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 15px;
    color: var(--link);
  }
  .buttons {
    display: flex;
    gap: 12px;
  }

  @media (max-width: 560px) {
    dialog {
      width: 100%;
      max-width: 100%;
      margin: auto 0 0;
      border-radius: 16px 16px 0 0;
    }
    .content {
      padding: 24px 20px 28px;
      gap: 16px;
    }
    h2 {
      font-size: 22px;
    }
    .intro {
      font-size: 15px;
    }
    .points {
      padding: 16px;
      font-size: 14px;
    }
    .buttons {
      width: 100%;
      flex-direction: column-reverse;
    }
  }
</style>
