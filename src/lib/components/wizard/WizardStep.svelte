<!--
  One step of the wizard's step track (WizardTrack) or step rail
  (WizardRail): a button with the step's numbered circle, its label and its
  value. A completed step shows a check and opens that step. In the track the
  circle sits above the label; in the rail it sits left of it, with the
  connector to the next step under it. The frame's `.short` makes the rail's
  step compact.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { goToStep, type WIZARD_STEPS } from "$lib/wizard.svelte.ts";

  let {
    step,
    index,
    current,
    value,
    backDisabled,
    navBlocked,
    rail = false,
    last = false,
  }: {
    step: (typeof WIZARD_STEPS)[number];
    /** The step's index among the steps. */
    index: number;
    /** The current step's index. */
    current: number;
    /** What the step shows under its label. */
    value: string;
    backDisabled: boolean;
    navBlocked: string | undefined;
    /** The step is in the rail rather than the track. */
    rail?: boolean;
    /** The rail's last step, which has no connector under it. */
    last?: boolean;
  } = $props();
  const done = $derived(index < current);
  const active = $derived(index === current);
</script>

{#snippet disc()}
  <span class="stepno" class:done class:on={active}>
    {#if done}<Icon name="check" size={12} />{:else}{index + 1}{/if}
  </span>
{/snippet}

{#snippet text()}
  <span class="step-label" class:active class:upcoming={!done && !active}>
    {step.label}
  </span>
  {#if value}
    <span class={active ? "step-status" : "step-summary"}>{value}</span>
  {/if}
{/snippet}

<!-- The track hides its labels below 600px, so its button is named by
     `aria-label`, and its title falls back to the value. -->
<button
  type="button"
  class={rail ? "rail-step" : "tstep"}
  class:active={!rail && active}
  disabled={!done || backDisabled || navBlocked !== undefined}
  title={rail
    ? done
      ? navBlocked
      : undefined
    : (done && navBlocked) || value || undefined}
  aria-label={rail ? undefined : step.label}
  onclick={() => goToStep(step.id)}
  aria-current={active ? "step" : undefined}
>
  {#if rail}
    <span class="rail-chain">
      {@render disc()}
      {#if !last}
        <span class="connector" class:done class:tolive={index === current - 1}
        ></span>
      {/if}
    </span>
    <span class="step-text">
      {@render text()}
    </span>
  {:else}
    <span class="hit">
      {@render disc()}
    </span>
    {@render text()}
  {/if}
</button>

<style>
  .stepno {
    position: relative;
    z-index: 1;
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

  /* ---- In the rail ------------------------------------------------------- */
  .rail-step {
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
  .rail-step:disabled {
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
    padding-top: 6px;
    min-width: 0;
  }
  .rail-step .step-summary,
  .rail-step .step-status {
    max-width: 180px;
  }

  /* A window 500px tall or less (the frame's .short). */
  :global(.short) .stepno {
    width: 24px;
    height: 24px;
    font-size: 11.5px;
  }
  :global(.short) .connector {
    height: 4px;
  }
  :global(.short) .step-text {
    padding-top: 4px;
  }
  :global(.short) .step-label {
    font-size: 13px;
  }
  :global(.short) .rail-step .step-summary,
  :global(.short) .rail-step .step-status {
    font-size: 11px;
    line-height: 13px;
    max-width: 118px;
  }

  /* ---- In the track ------------------------------------------------------ */
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
  .tstep .stepno {
    width: 24px;
    height: 24px;
    font-size: 11.5px;
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
  /* Below 600px: circles only. */
  @media (max-width: 599px) {
    .tstep .step-label,
    .tstep .step-status {
      display: none;
    }
  }
</style>
