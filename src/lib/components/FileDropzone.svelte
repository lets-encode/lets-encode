<!--
  Drag-and-drop / picker for the files a campaign is built from: page images,
  PDFs, and existing encodings. With a mouse or trackpad at hand it is a drop
  target with a picker button, flat in smaller windows; on touch-only devices a
  "Choose files" button, and files dragged in from another app (split view on a
  tablet) are taken by an overlay over the whole card. The queued files are
  listed under it, in a panel that takes the card's spare height on tall
  screens. Unsupported files are rejected with a note rather than silently
  dropped. The list is additive, so several drops (or a drop plus a pick) build
  one sequence, in the order the pages should read.
-->
<script lang="ts">
  import { classifyUpload } from "$lib/prepare-images.ts";
  import { wizardLayout } from "$lib/wizard-layout.svelte.ts";
  import Icon from "./Icon.svelte";

  let { files = $bindable() }: { files: File[] } = $props();

  let dragActive = $state(false);
  let note = $state<string | null>(null);

  const ACCEPT =
    "image/png,image/jpeg,application/pdf,.mei,.musicxml,.xml,.mxl";

  function add(incoming: File[]) {
    const accepted = incoming.filter((f) => classifyUpload(f) !== null);
    const rejected = incoming.length - accepted.length;
    // A repeated drop of the same file is a slip, not a second page.
    const fresh = accepted.filter(
      (f) => !files.some((e) => e.name === f.name && e.size === f.size),
    );
    files = [...files, ...fresh];
    const skippedDuplicates = accepted.length - fresh.length;
    note =
      rejected || skippedDuplicates
        ? [
            rejected && `${rejected} file(s) skipped — unsupported type.`,
            skippedDuplicates && `${skippedDuplicates} already added.`,
          ]
            .filter(Boolean)
            .join(" ")
        : null;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
    add(Array.from(e.dataTransfer?.files ?? []));
  }

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    add(Array.from(input.files ?? []));
    // Clear the input so picking the same file again still fires a change.
    input.value = "";
  }

  // Files dragged over the window on a device without a drop zone: the
  // overlay covers the card holding this control. Enter and leave fire for
  // every element crossed, so a count tells when the drag has left the window.
  let root = $state<HTMLDivElement>();
  let overlay = $state<string | null>(null);
  let depth = 0;
  const carriesFiles = (e: DragEvent) =>
    e.dataTransfer?.types.includes("Files") ?? false;
  function onWindowDragEnter(e: DragEvent) {
    if (wizardLayout.dropZone || !carriesFiles(e)) return;
    depth++;
    if (overlay !== null) return;
    const card = root?.closest("section")?.getBoundingClientRect();
    if (!card) return;
    overlay = `top: ${card.top + 10}px; left: ${card.left + 10}px; width: ${card.width - 20}px; height: ${card.height - 20}px`;
  }
  function onWindowDragLeave() {
    if (overlay === null) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay = null;
  }
  function onWindowDragOver(e: DragEvent) {
    // Without this the browser opens a file dropped beside the overlay.
    if (overlay !== null) e.preventDefault();
  }
  function onWindowDrop(e: DragEvent) {
    if (overlay === null) return;
    e.preventDefault();
    overlay = null;
    depth = 0;
    add(Array.from(e.dataTransfer?.files ?? []));
  }

  function remove(index: number) {
    files = files.filter((_, i) => i !== index);
  }

  /** The file-type label on a row's chip, from the file's extension. */
  const kindOf = (name: string) =>
    (name.match(/\.([^.]+)$/)?.[1] ?? "file").toUpperCase().slice(0, 4);

  const sizeOf = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
</script>

<svelte:window
  ondragenter={onWindowDragEnter}
  ondragleave={onWindowDragLeave}
  ondragover={onWindowDragOver}
  ondrop={onWindowDrop}
/>

<div
  class="upload"
  role="group"
  aria-label="File upload"
  bind:this={root}
  ondragover={(e) => {
    if (!wizardLayout.dropZone) return;
    e.preventDefault();
    dragActive = true;
  }}
  ondragleave={() => (dragActive = false)}
  ondrop={(e) => wizardLayout.dropZone && onDrop(e)}
>
  {#if wizardLayout.dropZone}
    <div class="dropzone" class:drag={dragActive}>
      <div class="arrow" aria-hidden="true">
        <Icon name="upload" size={40} />
      </div>
      <div class="drop-text">
        <div class="prompt">Drop page images, PDFs or MEI encodings here</div>
        <div class="types">You can combine them — or continue without any.</div>
      </div>
      <label class="picker">
        <input type="file" accept={ACCEPT} multiple onchange={onPick} />
        Browse files
      </label>
    </div>
  {:else}
    <label class="choose">
      <input type="file" accept={ACCEPT} multiple onchange={onPick} />
      <Icon name="upload" size={22} />
      <span class="choose-text">
        <span class="choose-label">Choose files</span>
        <span class="types">Page images, PDFs or MEI · optional</span>
      </span>
    </label>
  {/if}

  {#if note}
    <p class="note">{note}</p>
  {/if}

  {#if files.length}
    <div class="files">
      <div class="files-head">
        <span>Added files · {files.length}</span>
        <span>Read when you continue</span>
      </div>
      {#each files as file, i (`${file.name}:${file.size}`)}
        <div class="file-row">
          <div class="kind">{kindOf(file.name)}</div>
          <div class="file-text">
            <div class="name">{file.name}</div>
            <div class="meta">{sizeOf(file.size)} · read on Continue</div>
          </div>
          <button
            type="button"
            class="remove"
            onclick={() => remove(i)}
            aria-label="Remove {file.name}"
          >
            <Icon name="close" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if overlay !== null}
  <div class="drop-overlay" style={overlay} aria-hidden="true">
    <span class="overlay-icon"><Icon name="upload" size={30} /></span>
    <span class="overlay-title">Drop to add files</span>
    <span class="types">Page images, PDFs or MEI encodings</span>
  </div>
{/if}

<style>
  .upload {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 20px;
  }
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 56px 40px;
    border: 2px dashed var(--accent-line-strong);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-tint) 55%, transparent);
  }
  .dropzone.drag {
    border-color: var(--accent);
    background: var(--bg-tint);
  }
  .arrow {
    display: flex;
    color: var(--accent);
  }
  .prompt {
    font-size: 17px;
    font-weight: 600;
    margin-top: 12px;
  }
  .types {
    font-size: 13px;
    color: var(--ink-faint);
    margin-top: 6px;
  }
  .picker {
    display: inline-block;
    cursor: pointer;
    margin-top: 16px;
    font: 600 13.5px var(--font);
    padding: 9px 24px;
    color: var(--accent);
    background: var(--card);
    border: 1px solid var(--accent-line);
    border-radius: 999px;
  }
  @media (hover: hover) {
    .picker:hover {
      background: var(--bg-tint);
    }
  }
  .picker input,
  .choose input {
    display: none;
  }
  /* Smaller windows: one row of icon, text and button. */
  @media (max-width: 999px), (max-height: 760px) {
    .dropzone {
      flex-direction: row;
      gap: 16px;
      min-height: 104px;
      box-sizing: border-box;
      padding: 16px 20px;
      text-align: left;
    }
    .arrow :global(svg) {
      width: 28px;
      height: 28px;
    }
    .prompt {
      margin-top: 0;
      font-size: 15px;
    }
    .picker {
      flex: none;
      margin: 0 0 0 auto;
    }
  }
  .choose {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 56px;
    box-sizing: border-box;
    padding: 8px 18px;
    cursor: pointer;
    color: var(--accent);
    background: var(--accent-tint);
    border: 1px solid var(--accent-line);
    border-radius: 12px;
  }
  .choose-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .choose-label {
    font-size: 16px;
    font-weight: 600;
  }
  .choose .types {
    margin-top: 1px;
    font-size: 12.5px;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .files-head {
    display: none;
  }
  /* Tall screens: the list is a panel that takes the card's spare height, so
     the footer stays at the card's foot. */
  @media (min-height: 900px) {
    .upload {
      flex: 1 1 auto;
    }
    .files {
      flex: 1 1 auto;
      min-height: 130px;
      overflow: auto;
      padding: 10px 12px 12px;
      background: var(--bg-alt);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .files-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--ink-faint);
    }
    .files-head span:first-child {
      font-weight: 600;
      color: var(--ink-soft);
    }
  }
  /* Phones in landscape: the button and the list side by side. A drop zone
     takes at most half the row, so the list keeps room for the file names. */
  @media (max-height: 500px) {
    .upload {
      flex-direction: row;
      align-items: flex-start;
    }
    .dropzone {
      flex: 0 1 50%;
      min-width: 0;
      flex-wrap: wrap;
      gap: 8px 12px;
      min-height: 0;
      padding: 12px 14px;
    }
    .dropzone .arrow,
    .dropzone .types {
      display: none;
    }
    .dropzone .picker {
      margin-left: 0;
    }
    .files {
      flex: 1 1 50%;
      min-width: 200px;
    }
  }
  .drop-overlay {
    position: fixed;
    z-index: 40;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
    pointer-events: none;
    border: 2px dashed var(--accent-line-strong);
    border-radius: 18px;
    background: color-mix(in srgb, var(--accent-tint) 95%, transparent);
  }
  .overlay-icon {
    width: 72px;
    height: 72px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: var(--accent);
    background: var(--card);
  }
  .overlay-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--ink);
  }
  .note {
    flex: none;
    margin: 0;
    font-size: 12px;
    color: var(--warn);
  }
  .file-row {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px 16px;
  }
  .kind {
    flex: none;
    width: 34px;
    height: 42px;
    box-sizing: border-box;
    background: var(--card);
    border: 1px solid var(--accent-line);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 600 10px var(--font);
    color: var(--accent);
  }
  .file-text {
    min-width: 0;
  }
  .name {
    font:
      12.5px ui-monospace,
      Menlo,
      monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 2px;
  }
  .remove {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    cursor: pointer;
    width: 32px;
    height: 32px;
    font-size: 14px;
    color: var(--ink-faint);
    background: none;
    border: 1px solid var(--line);
    border-radius: 999px;
  }
  @media (pointer: coarse) {
    .remove {
      width: 44px;
      height: 44px;
    }
  }
  @media (hover: hover) {
    .remove:hover {
      color: var(--danger);
      border-color: var(--danger);
    }
  }
</style>
