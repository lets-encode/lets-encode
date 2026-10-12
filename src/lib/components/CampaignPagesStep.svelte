<!--
  Wizard step 4: which pages of the upload the campaign encodes, and in what
  order. A source is routinely larger than the part of it being encoded — a few
  pages of a long PDF, one piece out of a digitised volume — so the pages the
  previous step read are shown here as previews to choose between, and can be
  moved into reading order.

  On Continue the chosen pages are fetched or rendered at committing size — and
  only those, so an unchosen page costs nothing — and kept in the browser
  (draft-images.ts). The final step creates the campaign repository and commits
  them there with the configuration, tracking tables and piece MEIs. An upload
  with no page images never reaches this step: navigation skips it.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import { resolvePages } from "$lib/prepare-images.ts";
  import {
    wizard,
    draftSnapshot,
    keepDraftImages,
    saveDraft,
    nextStep,
    previousStep,
  } from "$lib/wizard.svelte.ts";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import WizardCard from "./WizardCard.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import PagesPerRow from "./PagesPerRow.svelte";
  import ZoomLevel, {
    fitPageZoom,
    nearFit,
    ZOOM_MAX,
    ZOOM_MIN,
  } from "./ZoomLevel.svelte";
  import { zoomGestures } from "$lib/zoom-gestures.ts";
  import Icon from "./Icon.svelte";
  import { wizardLayout } from "$lib/wizard-layout.svelte.ts";

  let busy = $state(false);
  let error = $state<string | null>(null);
  // Whether reading the pages has been attempted here and stopped part way,
  // which is what makes the next press a retry of it.
  let failed = $state(false);
  const log = new ProgressLog();

  // Fewer pages than the row would hold show one row at its widest; a long
  // source packs more per row. Phones and tablets, whose pane is narrow,
  // start at two; a window 500px tall or less shows whole pages, five to a
  // row. Not persisted, so every setup starts here.
  function defaultPerRow(count: number) {
    if (wizardLayout.short) return Math.min(5, count) || 1;
    if (wizardLayout.materialMode !== "side") return Math.min(2, count) || 1;
    if (count <= 4) return Math.max(1, count);
    return count > 10 ? 5 : 4;
  }
  let perRow = $state(defaultPerRow(wizard.candidates.length));
  // Beside the card the pane can be narrow: once its width is known, the
  // starting row holds no more pages than fit at MIN_TILE each (the grid has
  // 16px padding and 14px gaps).
  const MIN_TILE = 140;
  let rowFitted = false;
  $effect(() => {
    if (rowFitted || !bodyW || wizardLayout.materialMode !== "side") return;
    rowFitted = true;
    perRow = Math.max(
      1,
      Math.min(perRow, Math.floor((bodyW - 32 + 14) / (MIN_TILE + 14))),
    );
  });
  let zoom = $state(100);
  let fit = $state<"width" | "page" | null>(wizardLayout.short ? "page" : null);
  // The body's inner size and each preview's own size, for the page fit.
  let bodyW = $state(0);
  let bodyH = $state(0);
  let natW = $state<number[]>([]);
  let natH = $state<number[]>([]);
  const fitPage = $derived(
    fitPageZoom(
      bodyW,
      bodyH,
      perRow,
      natW.map((w, i) => (natH[i] ?? 0) / (w || 1)),
    ),
  );

  // The page a range selection is measured from: the last one clicked on its own.
  let anchor: number | null = null;
  // The page being dragged, and the one it is currently over.
  let dragIndex = $state<number | null>(null);
  let overIndex = $state<number | null>(null);

  // Touch: holding a page still lifts it, and it lands where the finger lets
  // go. A finger that moves before the hold completes scrolls instead. The
  // tap that ends a hold does not also keep or drop the page.
  const HOLD_MS = 450;
  const SLOP = 10;
  let lifted = $state(false);
  let swallowClick = false;
  function liftToReorder(list: HTMLElement) {
    let hold: { timer: number; x: number; y: number } | null = null;
    const cancelHold = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    const indexAt = (x: number, y: number) => {
      const li = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("li[data-index]");
      return li ? Number(li.dataset.index) : null;
    };
    const start = (e: TouchEvent) => {
      swallowClick = false;
      cancelHold();
      const index = indexAt(e.touches[0].clientX, e.touches[0].clientY);
      if (busy || e.touches.length !== 1 || index === null) return;
      const { clientX: x, clientY: y } = e.touches[0];
      hold = {
        x,
        y,
        timer: window.setTimeout(() => {
          hold = null;
          dragIndex = index;
          overIndex = index;
          lifted = true;
          swallowClick = true;
          navigator.vibrate?.(10);
        }, HOLD_MS),
      };
    };
    const drag = (e: TouchEvent) => {
      const t = e.touches[0];
      if (hold) {
        if (
          e.touches.length > 1 ||
          Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > SLOP
        )
          cancelHold();
        return;
      }
      if (!lifted) return;
      e.preventDefault();
      overIndex = indexAt(t.clientX, t.clientY) ?? overIndex;
      // Near the pane's top or bottom edge the pane scrolls along.
      const pane = list.parentElement;
      if (!pane) return;
      const box = pane.getBoundingClientRect();
      if (t.clientY < box.top + 48) pane.scrollTop -= 12;
      else if (t.clientY > box.bottom - 48) pane.scrollTop += 12;
    };
    const drop = (e: TouchEvent) => {
      cancelHold();
      if (!lifted) return;
      if (e.type === "touchend" && dragIndex !== null && overIndex !== null)
        move(dragIndex, overIndex);
      lifted = false;
      dragIndex = null;
      overIndex = null;
    };
    list.addEventListener("touchstart", start, { passive: true });
    list.addEventListener("touchmove", drag, { passive: false });
    list.addEventListener("touchend", drop);
    list.addEventListener("touchcancel", drop);
    return () => {
      cancelHold();
      list.removeEventListener("touchstart", start);
      list.removeEventListener("touchmove", drag);
      list.removeEventListener("touchend", drop);
      list.removeEventListener("touchcancel", drop);
    };
  }

  // One object URL per preview, cached so a re-render — a reorder, a change of
  // selection — hands the same <img> the same src. They are all released together
  // when the step goes away.
  const objectUrls = new Map<Blob, string>();
  const urls = $derived(
    wizard.candidates.map((page) => {
      let url = objectUrls.get(page.preview);
      if (!url) {
        url = URL.createObjectURL(page.preview);
        objectUrls.set(page.preview, url);
      }
      return url;
    }),
  );
  onDestroy(() => {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  });

  const chosen = $derived(wizard.candidates.filter((page) => page.include));
  // The number each kept page is committed under, so the numbering shown is the
  // one the campaign will have. A page left out has none.
  const numbers = $derived.by(() => {
    let n = 0;
    return wizard.candidates.map((page) => (page.include ? ++n : 0));
  });

  // Only an attempt that stopped part way is a retry.
  const continueLabel = $derived(
    busy
      ? "Working…"
      : failed
        ? "Retry"
        : chosen.length
          ? `Use ${chosen.length} page${chosen.length === 1 ? "" : "s"}`
          : "Continue without pages",
  );

  // The material toolbar names what the pages came from.
  const sourceName = $derived(
    wizard.files.length === 1
      ? wizard.files[0].name
      : wizard.files.length
        ? `${wizard.files.length} files`
        : wizard.iiifManifestUrl.trim() || "",
  );

  /**
   * Keep or leave out a page. Holding shift extends from the page last clicked
   * on its own, so a run of pages in a long source is chosen in two clicks.
   */
  function toggle(index: number, extend: boolean) {
    const include = !wizard.candidates[index].include;
    const from = extend && anchor !== null ? Math.min(anchor, index) : index;
    const to = extend && anchor !== null ? Math.max(anchor, index) : index;
    for (let i = from; i <= to; i++) wizard.candidates[i].include = include;
    anchor = index;
  }

  function setAll(include: boolean) {
    for (const page of wizard.candidates) page.include = include;
    anchor = null;
  }

  /** Move a page to another position, taking the rest along. */
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= wizard.candidates.length) return;
    const pages = [...wizard.candidates];
    const [page] = pages.splice(from, 1);
    pages.splice(to, 0, page);
    wizard.candidates = pages;
    anchor = null;
  }

  async function prepareAndContinue() {
    error = null;
    const user = auth.user;
    if (!user) {
      error = "You are signed out. Log in with GitHub to continue.";
      return;
    }

    busy = true;
    failed = false;
    log.clear();
    try {
      // The chosen pages are fetched and rendered at committing size here; the
      // final step commits them to the repository it creates.
      const pages = chosen.map(({ include, ...page }) => page);
      const images = pages.length
        ? await resolvePages(
            pages,
            ({ step, detail }) => {
              if (step) log.step(step);
              if (detail) log.detail(detail);
            },
            { brokerUrl: provider.brokerUrl },
          )
        : [];
      // Only a run that had pages to choose from replaces what the step already
      // produced. A continued setup, whose files cannot be picked again, keeps
      // the images it already holds.
      if (wizard.candidates.length) {
        wizard.images = images;
        log.step("Keeping the pages in this browser", { timed: false });
        await keepDraftImages(wizard.handle);
      }
      saveDraft(user.login, draftSnapshot());

      log.done();
      busy = false;
      nextStep();
    } catch (err) {
      console.error("Pages step failed:", (err as Error).message);
      error = `Could not read the pages: ${(err as Error).message}`;
      log.fail();
      failed = true;
      busy = false;
    }
  }
</script>

{#snippet material()}
  <div class="material-card">
    <div class="material-toolbar">
      {#if sourceName}
        <span class="toolbar-name">{sourceName}</span>
      {/if}
      <div class="toolbar-gap"></div>
      <PagesPerRow bind:value={perRow} />
      <ZoomLevel bind:value={zoom} bind:fit {fitPage} />
      <div class="toolbar-rule"></div>
      <span class="tbtn-pair">
        <button
          type="button"
          class="tbtn tbtn-icon"
          class:on={chosen.length === wizard.candidates.length}
          aria-pressed={chosen.length === wizard.candidates.length}
          aria-label="Keep all"
          title="Keep all"
          onclick={() => setAll(true)}
          disabled={busy}
        >
          <Icon name="pages" size={16} />
        </button>
        <button
          type="button"
          class="tbtn tbtn-icon"
          class:on={chosen.length === 0}
          aria-pressed={chosen.length === 0}
          aria-label="Keep none"
          title="Keep none"
          onclick={() => setAll(false)}
          disabled={busy}
        >
          <Icon name="page-none" size={16} />
        </button>
      </span>
    </div>
    <div
      class="material-body"
      bind:clientWidth={bodyW}
      bind:clientHeight={bodyH}
      {@attach zoomGestures({
        get: () => zoom,
        set: (z) => {
          zoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
          fit = null;
        },
        follow: true,
        onpinchend: () => (fit = nearFit(zoom, fitPage)),
      })}
    >
      <ol
        class="material-grid"
        class:fit-page={fit === "page"}
        style="--per-row: {perRow}; width: {zoom}%; --page-row: {Math.max(
          0,
          bodyH - 30,
        )}px"
        {@attach liftToReorder}
      >
        {#each wizard.candidates as page, i (page.id)}
          <li
            data-index={i}
            class:out={!page.include}
            class:lifted={lifted && dragIndex === i}
            class:dragging={!lifted && dragIndex === i}
            class:drop-before={dragIndex !== null &&
              overIndex === i &&
              dragIndex > i}
            class:drop-after={dragIndex !== null &&
              overIndex === i &&
              dragIndex < i}
            ondragover={(e) => {
              if (dragIndex === null) return;
              // Accepting the drag is what makes this position a drop target.
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              overIndex = i;
            }}
            ondragleave={() => {
              if (overIndex === i) overIndex = null;
            }}
            ondrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) move(dragIndex, i);
              dragIndex = null;
              overIndex = null;
            }}
          >
            <button
              type="button"
              class="thumb"
              aria-pressed={page.include}
              disabled={busy}
              title={wizardLayout.coarse ? undefined : page.label}
              draggable={!busy && !wizardLayout.coarse}
              onclick={(e) => {
                if (swallowClick) swallowClick = false;
                else toggle(i, e.shiftKey);
              }}
              oncontextmenu={(e) => wizardLayout.coarse && e.preventDefault()}
              onkeydown={(e) => {
                if (!e.altKey) return;
                const by =
                  e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? -1
                    : e.key === "ArrowRight" || e.key === "ArrowDown"
                      ? 1
                      : 0;
                if (!by) return;
                e.preventDefault();
                move(i, i + by);
              }}
              ondragstart={(e) => {
                dragIndex = i;
                // Firefox starts a drag only once the transfer carries data.
                e.dataTransfer?.setData("text/plain", String(i));
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              ondragend={() => {
                dragIndex = null;
                overIndex = null;
              }}
            >
              <!-- An image is draggable in its own right, which would drag the
                 picture instead of the page. -->
              <img
                src={urls[i]}
                alt={page.label}
                draggable="false"
                bind:naturalWidth={natW[i]}
                bind:naturalHeight={natH[i]}
              />
              <span class="mark" aria-hidden="true">
                {page.include ? numbers[i] : "—"}
              </span>
              {#if !page.include}
                <span class="left-out" aria-hidden="true"
                  ><span>left out</span></span
                >
              {/if}
            </button>
            <span class="page-caption">p. {i + 1}</span>
          </li>
        {/each}
      </ol>
    </div>
  </div>
{/snippet}

{#snippet hints()}
  <ul class="how">
    {#if wizardLayout.coarse}
      <li>Tap a page to keep or leave it out</li>
      <li>Hold a page, then drag it to move it</li>
    {:else}
      <li>Click a page to keep or leave it out</li>
      <li>Shift-click marks a whole run</li>
      <li>Drag a page to move it, or press Alt and an arrow key</li>
    {/if}
  </ul>
{/snippet}

<!-- The count as one line over its bar, under the heading when the pages take
     the card's body. -->
{#snippet minibar()}
  <div class="minibar">
    <div class="progress">
      <div
        class="progress-fill"
        style="width: {(chosen.length / wizard.candidates.length) * 100}%"
      ></div>
    </div>
    <span class="minibar-count"
      ><b>{chosen.length}</b> of {wizard.candidates.length} kept</span
    >
  </div>
{/snippet}

<WizardCard
  step="pages"
  heading="Choose the pages"
  intro="Keep what gets encoded, in reading order. Only the pages you keep are downloaded at full size and committed."
  status="{chosen.length} of {wizard.candidates.length} kept"
  onBack={previousStep}
  backDisabled={busy}
  onNext={prepareAndContinue}
  nextDisabled={busy}
  nextLabel={continueLabel}
  material={wizard.candidates.length ? material : undefined}
  info={hints}
  compactHead={minibar}
>
  {#if !wizard.candidates.length}
    <p class="note">
      There are no page images in this upload.
      {#if wizard.encodings.length}
        Its {wizard.encodings.length} encoding{wizard.encodings.length === 1
          ? " becomes a piece in its own right and needs"
          : "s become pieces in their own right and need"} no pages chosen.
      {/if}
    </p>
  {:else}
    <div class="count-row">
      <span class="count">{chosen.length}</span>
      <span class="count-of">of {wizard.candidates.length} pages kept</span>
    </div>
    <div class="progress">
      <div
        class="progress-fill"
        style="width: {wizard.candidates.length
          ? (chosen.length / wizard.candidates.length) * 100
          : 0}%"
      ></div>
    </div>
    {@render hints()}
  {/if}

  {#snippet pinned()}
    {#if error}
      <p class="msg-error" role="alert">{error}</p>
    {/if}
    <ProgressSteps {log} />
  {/snippet}
</WizardCard>

<style>
  .note {
    margin: 22px 0 0;
    font-size: 13.5px;
    color: var(--ink-soft);
  }
  .count-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 22px;
  }
  .count {
    font-size: 34px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .count-of {
    font-size: 14px;
    color: var(--ink-faint);
  }
  .progress {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    margin-top: 10px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .minibar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }
  .minibar .progress {
    flex: 1;
    margin: 0;
  }
  /* A window 500px tall or less shows the count in the step rail beside the
     card, so the pages get this row too. */
  @media (max-height: 500px) and (min-width: 640px) {
    .minibar {
      display: none;
    }
  }
  .minibar-count {
    font-size: 13px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .minibar-count b {
    font-weight: 600;
    color: var(--ink);
  }
  .how {
    list-style: none;
    margin: 22px 0 0;
    padding: 0;
    display: grid;
    gap: 9px;
    font-size: 12.5px;
    color: var(--ink-soft);
  }

  /* ---- Page tiles in the material pane ---- */
  ol.material-grid {
    list-style: none;
    margin: 0;
  }
  li {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  /* A page held by a finger, following it until it is let go. */
  li.lifted .thumb {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
    transform: scale(1.04);
    box-shadow: var(--shadow);
  }
  li.dragging {
    opacity: 0.4;
  }
  /* Where the dragged page lands: before or after the page it is over. */
  li.drop-before::before,
  li.drop-after::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent);
    border-radius: 2px;
    z-index: 1;
  }
  li.drop-before::before {
    left: -8px;
  }
  li.drop-after::after {
    right: -8px;
  }
  .thumb {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    background: var(--facsimile-paper);
    border: 1px solid var(--accent-line);
    border-radius: 6px;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    cursor: pointer;
    /* Safari drags an element from a form control only when told to. */
    -webkit-user-drag: element;
    /* A held page lifts for reordering instead of opening the image menu or
       selecting text. */
    -webkit-touch-callout: none;
    user-select: none;
  }
  li.out .thumb {
    border-color: var(--line);
    opacity: 0.8;
  }
  li.out img {
    opacity: 0.55;
  }
  .thumb img {
    display: block;
    width: 100%;
    /* The preview takes its tile's width, so the zoom level sets how large a
       page is shown; the proportions of a page hold it to a fixed height. */
    aspect-ratio: 0.73;
    object-fit: contain;
  }
  .mark {
    position: absolute;
    top: 8px;
    left: 8px;
    box-sizing: border-box;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: #fff;
    background: var(--accent-btn);
    border-radius: 10px;
  }
  li.out .mark {
    color: var(--ink-faint);
    background: var(--line);
  }
  /* Diagonal stripes and a pill over a page that is left out. */
  .left-out {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: repeating-linear-gradient(
      45deg,
      rgba(121, 128, 154, 0.08) 0 8px,
      transparent 8px 16px
    );
  }
  .left-out span {
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-faint);
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    line-height: 1;
    padding: 4px 10px;
  }
</style>
