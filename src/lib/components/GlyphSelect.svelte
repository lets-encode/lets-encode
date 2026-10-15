<!--
  A select whose options carry a music symbol (MusicGlyph), which a native
  select cannot draw: a button showing the chosen option, opening a listbox
  below it, or above it where the window has no room below. Keyboard: the
  arrow keys, Home and End move through the list, Enter or Space chooses,
  Escape and Tab close it. A press outside, a scroll or a resize closes it.
  A disabled option is shown but cannot be chosen. The options named in
  `top` are listed first as well, above a divider before the full list.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import MusicGlyph, { type MusicGlyphName } from "./MusicGlyph.svelte";

  type Option = {
    value: string;
    label: string;
    glyph?: MusicGlyphName;
    disabled?: boolean;
  };
  let {
    options,
    value,
    onchange,
    label,
    title,
    class: className = "",
    top = [],
  }: {
    options: readonly Option[];
    value: string;
    onchange: (value: string) => void;
    /** The accessible name of the control. */
    label: string;
    title?: string;
    class?: string;
    /** Values of the most used options, listed again at the top. */
    top?: readonly string[];
  } = $props();

  const id = $props.id();
  const chosen = $derived(options.find((o) => o.value === value));
  // The list as shown: the top options, then every option.
  const lead = $derived(
    top
      .map((v) => options.find((o) => o.value === v))
      .filter((o): o is Option => !!o),
  );
  const shown = $derived([...lead, ...options]);
  let open = $state(false);
  let active = $state(0);
  let button = $state<HTMLButtonElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);
  let place = $state({ left: 0, top: 0, width: 0, above: false });

  const LIST_MAX = 280;

  async function show() {
    if (!button) return;
    const box = button.getBoundingClientRect();
    const above =
      window.innerHeight - box.bottom < LIST_MAX && box.top > LIST_MAX;
    place = {
      left: box.left,
      top: above ? box.top - 4 : box.bottom + 4,
      width: Math.max(box.width, 180),
      above,
    };
    active = Math.max(
      0,
      shown.findIndex((o) => o.value === value),
    );
    open = true;
    await Promise.resolve();
    list?.focus();
    list
      ?.querySelector<HTMLElement>(`#${id}-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }
  function close(refocus = true) {
    open = false;
    if (refocus) button?.focus();
  }
  function choose(i: number) {
    const option = shown[i];
    if (option?.disabled) return;
    close();
    if (option && option.value !== value) onchange(option.value);
  }
  function move(to: number) {
    active = Math.min(shown.length - 1, Math.max(0, to));
    list
      ?.querySelector<HTMLElement>(`#${id}-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }
  function buttonKey(e: KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      void show();
    }
  }
  function listKey(e: KeyboardEvent) {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(active + 1),
      ArrowUp: () => move(active - 1),
      Home: () => move(0),
      End: () => move(shown.length - 1),
      Enter: () => choose(active),
      " ": () => choose(active),
      Escape: () => close(),
    };
    if (e.key === "Tab") return close(false);
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  }

  // A press outside, a scroll anywhere or a resize closes the list.
  $effect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!list?.contains(target) && !button?.contains(target)) close(false);
    };
    const away = (e: Event) => {
      if (!list?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  });
</script>

<button
  bind:this={button}
  type="button"
  class="gsel {className}"
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-label={`${label}: ${chosen?.label ?? ""}`}
  {title}
  onclick={() => (open ? close() : show())}
  onkeydown={buttonKey}
>
  <span class="gmark"
    >{#if chosen?.glyph}<MusicGlyph name={chosen.glyph} />{/if}</span
  >
  <span class="gtext">{chosen?.label ?? ""}</span>
  <Icon name="chevron-down" size={12} />
</button>
{#if open}
  <ul
    bind:this={list}
    class="glist"
    class:above={place.above}
    role="listbox"
    tabindex="-1"
    aria-label={label}
    aria-activedescendant={`${id}-${active}`}
    style:left="{place.left}px"
    style:top="{place.top}px"
    style:min-width="{place.width}px"
    style:max-height="{LIST_MAX}px"
    onkeydown={listKey}
  >
    {#each shown as option, i (i)}
      {#if i === lead.length && i > 0}
        <li class="gsep" role="presentation"></li>
      {/if}
      <!-- The keyboard acts on the listbox (listKey), not on each option. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        id={`${id}-${i}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled}
        class:active={i === active}
        onpointermove={() => (active = i)}
        onclick={() => choose(i)}
      >
        <span class="gmark"
          >{#if option.glyph}<MusicGlyph name={option.glyph} />{/if}</span
        >
        {option.label}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .gsel {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    text-align: left;
    cursor: pointer;
  }
  .gsel > :global(.icon) {
    margin-left: auto;
    color: var(--ink-soft);
  }
  .gtext {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The symbol's column: the same width for every option, so the names
     line up. */
  .gmark {
    flex: none;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    width: 14px;
    height: 1em;
  }
  .glist {
    position: fixed;
    z-index: 50;
    margin: 0;
    padding: 4px;
    list-style: none;
    overflow-y: auto;
    font: 13px var(--font);
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    box-shadow:
      0 1px 2px rgba(31, 36, 51, 0.06),
      0 12px 30px rgba(31, 36, 51, 0.13);
    box-sizing: border-box;
  }
  .glist.above {
    transform: translateY(-100%);
  }
  .glist:focus {
    outline: none;
  }
  .glist > li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 2px 10px 2px 6px;
    border-radius: 6px;
    white-space: nowrap;
    cursor: pointer;
  }
  .glist > li.gsep {
    min-height: 0;
    height: 1px;
    margin: 4px 6px;
    padding: 0;
    background: var(--line);
    cursor: default;
  }
  .glist > li.active {
    background: var(--accent-tint-strong);
  }
  .glist > li[aria-selected="true"] {
    font-weight: 600;
  }
  .glist > li[aria-disabled="true"] {
    color: var(--ink-faint);
    cursor: not-allowed;
  }
</style>
