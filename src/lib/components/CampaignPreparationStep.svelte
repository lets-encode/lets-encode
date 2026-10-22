<!--
  Wizard step 7: whether the facsimile pieces go through optical music
  recognition, which decides how they get their measures and whether encoding
  starts from a draft, and the button that finishes the setup. Measure detection contacts
  the edirom detector for every page when Create campaign is pressed; both optical music
  recognition options leave the pages as they are — their staves and measures
  are found in each piece's measure correction task.

  Finishing creates the repository, builds the scores, the configuration and
  the tables and commits them with the pages (campaign-finish.svelte.ts). The step is skipped when the campaign has
  no page images; the pieces step finishes the setup then.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { wizard, previousStep } from "$lib/wizard.svelte.ts";
  import { auth } from "$lib/auth.svelte.ts";
  import {
    CampaignFinisher,
    finishSummary,
  } from "$lib/campaign-finish.svelte.ts";
  import type { Preparation } from "$lib/campaign-init.ts";
  import WizardCard from "./WizardCard.svelte";
  import FacsimilePages from "./FacsimilePages.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";

  const OPTIONS: { id: Preparation; name: string; info: string }[] = [
    {
      id: "measure-detection",
      name: "Measure detection",
      info:
        "Measure boxes are detected on every page when you create the campaign and corrected by " +
        "volunteers in a measure-correction task. Encoding starts from empty measures. " +
        "Page images are sent to the Edirom measure detector (measure-detector.edirom.de).",
    },
    {
      id: "omr",
      name: "Optical music recognition with a score setup task",
      info:
        "Staves and measures are detected and corrected in a measure correction task. The staves are then " +
        "transcribed in the score setup, and each page's encoding starts from that draft. " +
        "Page images are sent to the Musibot service (Charles University) for recognition.",
    },
    {
      id: "omr-instruments",
      name: "Optical music recognition with instruments named during measure correction",
      info:
        "Staves and measures are detected and corrected in a measure correction task, which also names the " +
        "instrument of every staff and transcribes the staves. The first page's encoding task starts with a " +
        "check of the clefs, key and meter, and each page's encoding starts from the draft. " +
        "Page images are sent to the Musibot service (Charles University) for recognition.",
    },
  ];

  const finisher = new CampaignFinisher();
  onDestroy(() => finisher.cancel());
</script>

{#snippet material()}
  <FacsimilePages pages={wizard.images} />
{/snippet}

<WizardCard
  step="preparation"
  heading="Prepare the scores"
  intro="Optical music recognition turns the pages into a draft that encoding starts from. Choose now whether to use it: this cannot be changed once the campaign is created."
  status="choosing the preparation"
  {material}
  panes={{
    form: "Options",
    material: "Pages",
    materialCount: wizard.images.length,
  }}
  onBack={previousStep}
  backDisabled={finisher.busy}
  onNext={() => finisher.run()}
  nextDisabled={finisher.busy}
  nextLabel={finisher.busy
    ? "Working…"
    : finisher.error
      ? "Retry"
      : "Create campaign"}
  nextIcon={finisher.busy ? null : finisher.error ? "arrow-right" : "check"}
  finish={!finisher.error}
>
  <div class="options" role="radiogroup" aria-label="Preparation">
    {#each OPTIONS as option (option.id)}
      <label class="option" class:on={wizard.preparation === option.id}>
        <input
          type="radio"
          name="preparation"
          value={option.id}
          bind:group={wizard.preparation}
          onchange={() => finisher.reset()}
          disabled={finisher.busy}
        />
        <span class="option-text">
          <span class="option-name">{option.name}</span>
          <span class="option-info">{option.info}</span>
        </span>
      </label>
    {/each}
  </div>

  {#snippet pinned()}
    {#if finisher.error}
      <p class="msg-error" role="alert">{finisher.error}</p>
    {:else if !finisher.busy && auth.user}
      <p class="finish-note">{finishSummary(auth.user.login)}</p>
    {/if}
    <ProgressSteps log={finisher.log} />
  {/snippet}
</WizardCard>
