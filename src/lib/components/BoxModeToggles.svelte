<!--
  A box editor's touch-screen toggles (BoxEditor): Draw, in which a finger
  drag draws a new box instead of scrolling, and Select several, in which a
  tap adds a box to the selection or takes it out.
-->
<script lang="ts" generics="T, S">
  import type { BoxEditor } from "$lib/box-editor.svelte.ts";
  import Icon from "./Icon.svelte";

  let {
    editor,
    noun,
    class: extra = "",
  }: {
    editor: BoxEditor<T, S>;
    /** What one box is called, e.g. "measure" or "region". */
    noun: string;
    /** Classes the editor adds to both buttons. */
    class?: string;
  } = $props();
</script>

<button
  type="button"
  class="tbtn tbtn-icon {extra}"
  class:on={editor.drawMode}
  class:drawhint={editor.drawHint && !editor.drawMode}
  aria-pressed={editor.drawMode}
  aria-label="Draw"
  title={`Draw: a finger drag draws a new ${noun}. Off, a drag scrolls the pages.`}
  onclick={() => editor.setDrawMode(!editor.drawMode)}
  ><Icon name="touch-box" size={16} /></button
>
<button
  type="button"
  class="tbtn tbtn-icon {extra}"
  class:on={editor.pickMode}
  aria-pressed={editor.pickMode}
  disabled={!editor.drawMode}
  aria-label="Select several"
  title={`A tap on a ${noun} adds it to the selection or takes it out`}
  onclick={() => (editor.pickMode = !editor.pickMode)}
  ><Icon name="select-several" size={16} /></button
>
