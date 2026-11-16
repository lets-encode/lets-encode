<!--
  The encoding alignment's two steps: the staves, then the measures, each
  with its count.
-->
<script lang="ts">
  import type { AlignedEncoding } from "$lib/encoding-merge.ts";
  import StepGlyph from "$lib/components/StepGlyph.svelte";

  let {
    step,
    aligned,
    used,
    ongo,
  }: {
    step: 1 | 2;
    aligned: AlignedEncoding;
    /** The number of file staves used. */
    used: number;
    ongo: (step: 1 | 2) => void;
  } = $props();
</script>

<div
  class="steps"
  role="group"
  aria-label="Steps"
  title="The two steps of the encoding alignment."
>
  {#each [{ step: 1, glyph: "staves", tone: "var(--ink-staff)", long: "Staves", count: `${used} of ${aligned.fileStaves.length} used`, n: `${used}/${aligned.fileStaves.length}` }, { step: 2, glyph: "measure", tone: "var(--ink-measure)", long: "Measures", count: `${aligned.summary.filled} of ${aligned.layout.length}`, n: `${aligned.summary.filled}/${aligned.layout.length}` }] as st (st.step)}
    <button
      type="button"
      class="step"
      class:on={step === st.step}
      aria-pressed={step === st.step}
      onclick={() => ongo(st.step as 1 | 2)}
      aria-label={`${st.step} · ${st.long}, ${st.count}`}
      ><span class="stepno">{st.step}</span><StepGlyph
        kind={st.glyph as "staves" | "measure"}
        tone={st.tone}
      /><span class="steplong">{st.long}</span><span class="stepshort"
        >{st.long}</span
      ><span class="stepn">{st.n}</span><span class="stepcount">{st.count}</span
      ></button
    >
  {/each}
</div>
