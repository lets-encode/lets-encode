<!--
  The score setup's two steps: the staves with the key and time signature,
  then the groups, each with its count.
-->
<script lang="ts">
  import StepGlyph from "$lib/components/StepGlyph.svelte";

  let {
    step,
    staves,
    groups,
    ongo,
  }: {
    step: 1 | 2;
    /** The number of staves. */
    staves: number;
    /** The number of groups. */
    groups: number;
    ongo: (step: 1 | 2) => void;
  } = $props();
</script>

<div
  class="steps"
  role="group"
  aria-label="Steps"
  title="The two steps of the score setup."
>
  {#each [{ step: 1, glyph: "staves", tone: "var(--ink-staff)", long: "Staves", count: `${staves}` }, { step: 2, glyph: "groups", tone: "var(--ink-grand)", long: "Groups", count: `${groups}` }] as st (st.step)}
    <button
      type="button"
      class="step"
      class:on={step === st.step}
      aria-pressed={step === st.step}
      onclick={() => ongo(st.step as 1 | 2)}
      aria-label={`${st.step} · ${st.long}, ${st.count}`}
      ><span class="stepno">{st.step}</span><StepGlyph
        kind={st.glyph as "staves" | "groups"}
        tone={st.tone}
      /><span class="steplong">{st.long}</span><span class="stepshort"
        >{st.long}</span
      ><span class="stepn">{st.count}</span><span class="stepcount"
        >{st.count}</span
      ></button
    >
  {/each}
</div>
