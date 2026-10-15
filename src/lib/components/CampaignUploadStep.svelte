<!--
  Wizard step 3: what the campaign is built from — page images, PDFs, existing
  encodings, a IIIF manifest, or nothing at all.

  Continuing reads the upload: a PDF is rasterised to one page per document page,
  a manifest's canvases are listed, and each page gets a small preview. Nothing
  is fetched at committing size — the next step chooses which of these pages the
  campaign keeps. An upload with no page images has nothing to choose, so that
  step is skipped and the flow continues at the source step. Reading a long
  source is the expensive part of this step, so coming back to it and continuing
  again with the same upload keeps the pages already read.
-->
<script lang="ts">
  import { provider } from "$lib/forge/config.ts";
  import {
    prepareCandidates,
    fetchIiifCanvases,
    type IiifCanvas,
  } from "$lib/prepare-images.ts";
  import {
    wizard,
    nextStep,
    previousStep,
    COPYRIGHT_ACKNOWLEDGEMENT,
  } from "$lib/wizard.svelte.ts";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import WizardCard from "./WizardCard.svelte";
  import FileDropzone from "./FileDropzone.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import { wizardLayout } from "$lib/wizard-layout.svelte.ts";

  let busy = $state(false);
  let error = $state<string | null>(null);
  const log = new ProgressLog();

  const manifestUrl = $derived(wizard.iiifManifestUrl.trim());
  const hasUpload = $derived(wizard.files.length > 0 || manifestUrl !== "");
  // The acknowledgement is about material being published, so it only gates
  // Continue when there is material.
  const canContinue = $derived(
    !busy && (!hasUpload || wizard.copyrightAccepted),
  );
  const continueLabel = $derived(
    busy ? "Working…" : hasUpload ? "Continue" : "Continue without images",
  );

  // What the rail reports while this step is open.
  const railStatus = $derived.by(() => {
    const parts: string[] = [];
    if (wizard.files.length)
      parts.push(
        `${wizard.files.length} file${wizard.files.length === 1 ? "" : "s"} added`,
      );
    if (manifestUrl) parts.push("IIIF manifest");
    return parts.join(" · ") || "adding material";
  });

  // What the pages already read were read from. A file is identified by name and
  // size, which is what the dropzone treats as one file too.
  const uploadKey = $derived(
    [...wizard.files.map((f) => `${f.name}:${f.size}`), manifestUrl].join("|"),
  );

  async function continueToNextStep() {
    error = null;
    if (!hasUpload) {
      wizard.candidates = [];
      wizard.uploadKey = "";
      log.clear();
      nextStep();
      return;
    }
    // The same upload as last time: its pages are still held, previews and all.
    if (wizard.uploadKey === uploadKey && uploadKey !== "") {
      nextStep();
      return;
    }

    busy = true;
    log.clear();
    try {
      let canvases: IiifCanvas[] = [];
      if (manifestUrl) {
        log.step("Reading the IIIF manifest");
        canvases = await fetchIiifCanvases(manifestUrl, provider.brokerUrl);
        log.detail(`${canvases.length} canvas(es)`);
      }

      const prepared = await prepareCandidates(
        wizard.files,
        canvases,
        ({ step, detail }) => {
          if (step) log.step(step);
          if (detail) log.detail(detail);
        },
        { brokerUrl: provider.brokerUrl },
      );
      // Everything is kept to begin with, so an upload that is all of the source
      // needs no choosing.
      wizard.candidates = prepared.candidates.map((page) => ({
        ...page,
        include: true,
      }));
      wizard.encodings = prepared.encodings;
      wizard.uploadKey = uploadKey;

      log.done();
      busy = false;
      nextStep();
    } catch (err) {
      console.error("Upload step failed:", (err as Error).message);
      error = `Could not read the upload: ${(err as Error).message}`;
      log.fail();
      busy = false;
    }
  }
</script>

<WizardCard
  step="upload"
  heading="Add your source"
  intro="{wizardLayout.dropZone
    ? 'Drop material here'
    : 'Add files'}, or point at a IIIF manifest. You pick which pages to keep next."
  status={railStatus}
>
  <FileDropzone bind:files={wizard.files} />

  <div class="divider" aria-hidden="true">
    <span>or from a IIIF server</span>
  </div>

  <label class="field manifest">
    IIIF manifest URL
    <input
      class="input"
      bind:value={wizard.iiifManifestUrl}
      placeholder="https://…/manifest.json"
      type="url"
    />
    <span class="hint">
      Its canvases are downloaded and committed with the campaign, so it keeps
      working if the source server does not.
    </span>
  </label>

  {#snippet pinned()}
    {#if error}
      <p class="msg-error" role="alert">{error}</p>
    {/if}
    <ProgressSteps {log} />
  {/snippet}

  <!-- The footer is this step's own: the acknowledgement gating Continue sits
       on the buttons' row, left of them. -->
  {#snippet footer()}
    <label class="ack">
      <input type="checkbox" bind:checked={wizard.copyrightAccepted} />
      <span>{COPYRIGHT_ACKNOWLEDGEMENT.text}</span>
    </label>
    <button
      type="button"
      class="btn btn-secondary"
      onclick={previousStep}
      disabled={busy}
    >
      Back
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={continueToNextStep}
      disabled={!canContinue}
    >
      {continueLabel}
    </button>
  {/snippet}
</WizardCard>

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 22px;
  }
  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .divider span {
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .manifest {
    margin-top: 14px;
  }
  .ack {
    display: flex;
    align-items: flex-start;
    align-self: center;
    gap: 9px;
    margin-right: auto;
    font-size: 12.5px;
    font-weight: 400;
    line-height: 1.5;
    color: var(--ink-soft);
    cursor: pointer;
  }
  .ack input {
    margin-top: 2px;
  }
</style>
