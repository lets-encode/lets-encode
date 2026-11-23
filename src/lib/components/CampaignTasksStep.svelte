<!--
  Wizard step 3: how the campaign's work is divided into tasks and reviewed.

  The division decides whether a piece's encoding is one task per page or one
  task for the whole piece (planTasks); dividing by part is shown as not yet
  available. The number of reviews per task sets the review columns of the
  state table, which is why it cannot change once the campaign exists. Self-review lets the encoder
  review their own work and one person give every review of a task.

  The values go into config.yaml when the campaign is created
  (campaign-finish.svelte.ts).
-->
<script lang="ts">
  import type { Division } from "$lib/campaign-init.ts";
  import {
    MAX_REVIEWS,
    wizard,
    nextStep,
    previousStep,
  } from "$lib/wizard.svelte.ts";
  import WizardCard from "./WizardCard.svelte";

  // A division without an id is shown as not yet available.
  const DIVISIONS: { id?: Division; name: string; info: string }[] = [
    {
      id: "page",
      name: "By page",
      info: "One encoding task per page of a piece.",
    },
    {
      name: "By part",
      info: "One encoding task per instrument or voice.",
    },
    {
      id: "none",
      name: "Not divided",
      info: "One encoding task per piece, with the whole score.",
    },
  ];

  const counts = Array.from({ length: MAX_REVIEWS }, (_, i) => i + 1);
</script>

<WizardCard
  step="tasks"
  heading="Set up the tasks"
  intro="How the encoding is divided into tasks and how many reviews each task gets."
  status={wizard.division === "none" ? "not divided" : "by page"}
  onBack={previousStep}
  onNext={nextStep}
>
  <span class="field group" id="division-label">Encoding is divided</span>
  <div class="options" role="radiogroup" aria-labelledby="division-label">
    {#each DIVISIONS as division (division.name)}
      <label
        class="option"
        class:on={division.id && wizard.division === division.id}
        class:unavailable={!division.id}
      >
        {#if division.id}
          <input
            type="radio"
            name="division"
            value={division.id}
            bind:group={wizard.division}
          />
        {:else}
          <input type="radio" name="division" disabled />
        {/if}
        <span class="option-text">
          <span class="option-name">{division.name}</span>
          <span class="option-info">{division.info}</span>
        </span>
        {#if !division.id}
          <span class="chip">Coming soon</span>
        {/if}
      </label>
    {/each}
  </div>

  <span class="field group" id="reviews-label">Reviews per task</span>
  <div class="counts" role="radiogroup" aria-labelledby="reviews-label">
    {#each counts as n (n)}
      <button
        type="button"
        class="chip-switch press-touch"
        class:on={wizard.reviews === n}
        role="radio"
        aria-checked={wizard.reviews === n}
        onclick={() => (wizard.reviews = n)}
      >
        {n}
      </button>
    {/each}
  </div>
  <span class="hint">Fixed once the campaign exists.</span>

  <div class="options">
    <label
      class="option"
      class:on={wizard.selfReview}
      title="The encoder of a task may also review it, and one person may give every review of a task."
    >
      <input type="checkbox" bind:checked={wizard.selfReview} />
      <span class="option-text">
        <span class="option-name">Allow reviewing your own encoding</span>
        <span class="option-info">For test campaigns.</span>
      </span>
    </label>
  </div>
</WizardCard>

<style>
  .group {
    margin-top: 24px;
  }
  .group + .options {
    margin-top: 10px;
  }
  .counts {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .option-text {
    flex: 1;
  }
  .unavailable {
    cursor: default;
    border-style: dashed;
    background: var(--bg-inset);
  }
  .unavailable:hover {
    border-color: var(--line);
  }
  .unavailable .option-name,
  .unavailable .option-info {
    color: var(--ink-faint);
  }
</style>
