<!--
  A task box's heading: the task's description and scope as the title, the
  piece and, where given, the task id on the line below. The piece title is
  shown in full, up to three lines: the panel is where a touch screen reads
  it. The piece dot takes --zone from the surrounding box.
-->
<script lang="ts">
  let {
    description,
    scope = "",
    piece,
    task,
  }: {
    /** What the task asks for ("Encode", "Score setup", …). */
    description: string;
    /** The part of the piece the task covers ("p. 3"); '' for the whole piece. */
    scope?: string;
    /** The display name of the task's piece; '' while unknown. */
    piece: string;
    /** The task id; '' leaves it out. */
    task: string;
  } = $props();
</script>

<div class="taskheading">
  <h3 class="name">
    {description}{#if scope}<span class="scope">{` · ${scope}`}</span>{/if}
  </h3>
  <div class="pieceline">
    {#if piece}
      <span class="dot"></span>
      <span class="pname" title={piece}>{piece}</span>
    {/if}
    {#if task}
      <code class="tid">{task}</code>
    {/if}
  </div>
</div>

<style>
  .taskheading {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .name {
    margin: 0;
    font-size: 15px;
    line-height: 1.25;
    font-weight: 600;
    color: var(--ink);
  }
  .scope {
    color: var(--ink-soft);
  }
  .pieceline {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone, var(--ink-faint));
    flex: none;
  }
  .pname {
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .tid {
    margin-left: auto;
    flex: none;
    font:
      400 10.5px ui-monospace,
      Menlo,
      monospace;
    color: var(--ink-faint);
  }
</style>
