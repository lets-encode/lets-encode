<!--
  One notice line: an icon and a headline in the state's colour, the detail
  below, an optional action button and an optional Dismiss. Where the line
  is narrow the button sits under the text, where it is wide at the right
  end (ui.css, .notice). Extra content (links, inputs) goes in children,
  below the detail.
-->
<script module lang="ts">
  /** A message split into a headline and a detail: at its first ": " when
      that comes before the end of the first sentence, else after the first
      sentence. The headline loses its closing full stop; the detail starts
      with a capital. */
  export function splitMessage(text: string): {
    title: string;
    detail: string;
  } {
    const colon = text.indexOf(": ");
    const stop = text.indexOf(". ");
    const at =
      colon >= 0 && (stop < 0 || colon < stop) ? colon : stop >= 0 ? stop : -1;
    const head = at < 0 ? text : text.slice(0, at);
    const rest = at < 0 ? "" : text.slice(at + 2).trim();
    return {
      title: head.replace(/\.$/, ""),
      detail: rest.charAt(0).toUpperCase() + rest.slice(1),
    };
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  type IconName = "warning" | "check-circle" | "eye" | "clock-pause" | "lock";

  let {
    tone,
    surface = "card",
    icon,
    title,
    detail = "",
    action,
    ondismiss,
    live = true,
    children,
  }: {
    tone: "err" | "warn" | "ok";
    /** inline: inside a box, on its wash under a hairline; card: a tinted
        card on the page; strip: full width with a bottom line. */
    surface?: "inline" | "card" | "strip";
    /** Defaults to warning, or check-circle for ok. */
    icon?: IconName;
    title: string | Snippet;
    detail?: string;
    /** A button, or with href a link drawn as one. */
    action?: {
      label: string;
      run?: () => void;
      href?: string;
      icon?: "arrow-left";
      disabled?: boolean;
    };
    ondismiss?: () => void;
    /** The line announces itself; off inside a live region of its own. */
    live?: boolean;
    children?: Snippet;
  } = $props();
</script>

<div
  class="notice {tone} {surface}"
  role={live ? (tone === "err" ? "alert" : "status") : undefined}
>
  <div class="notice-in">
    <span class="notice-icon"
      ><Icon
        name={icon ?? (tone === "ok" ? "check-circle" : "warning")}
        size={15}
      /></span
    >
    <div class="notice-text">
      <span class="notice-title"
        >{#if typeof title === "string"}{title}{:else}{@render title()}{/if}</span
      >
      {#if detail}<span>{detail}</span>{/if}
      {@render children?.()}
    </div>
    {#if action?.href}
      <a class="btn notice-action" href={action.href}
        >{#if action.icon}<Icon name={action.icon} />{/if}{action.label}</a
      >
    {:else if action}
      <button
        type="button"
        class="btn notice-action"
        disabled={action.disabled}
        onclick={action.run}
        >{#if action.icon}<Icon name={action.icon} />{/if}{action.label}</button
      >
    {/if}
    {#if ondismiss}
      <button
        type="button"
        class="btn btn-icon notice-x"
        aria-label="Dismiss"
        title="Dismiss"
        onclick={ondismiss}><Icon name="close" /></button
      >
    {/if}
  </div>
</div>
