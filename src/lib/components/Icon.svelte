<!--
  One stroke icon set for the console: 24-unit grid, 2px round strokes,
  drawn in currentColor so it takes the text colour of its parent. Decorative
  by default (aria-hidden); pass a label when the icon stands alone.
-->
<script lang="ts">
  type Name =
    | "arrow-right"
    | "external"
    | "chevron-right"
    | "chevron-left"
    | "chevron-down"
    | "chevron-up"
    | "arrow-left"
    | "arrow-up"
    | "arrow-down"
    | "check"
    | "close"
    | "search"
    | "info"
    | "gear"
    | "facsimile"
    | "notes"
    | "side-by-side"
    | "warning"
    | "check-circle"
    | "reset"
    | "lock"
    | "plus"
    | "sort"
    | "clock"
    | "upload"
    | "zoom-in"
    | "zoom-out"
    | "hand"
    | "square"
    | "pages"
    | "page-none"
    | "undo"
    | "redo"
    | "help"
    | "minus"
    | "trash"
    | "draw-box"
    | "comment"
    | "more";
  let {
    name,
    size = 14,
    label = "",
  }: { name: Name; size?: number; label?: string } = $props();
  const paths: Record<Name, string> = {
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    external: "M7 17 17 7M8 7h9v9",
    "chevron-right": "M9 6l6 6-6 6",
    "chevron-left": "M15 6l-6 6 6 6",
    "chevron-down": "M6 9l6 6 6-6",
    "chevron-up": "M6 15l6-6 6 6",
    "arrow-left": "M19 12H5M11 6l-6 6 6 6",
    "arrow-up": "M12 19V5M6 11l6-6 6 6",
    "arrow-down": "M12 5v14M6 13l6 6 6-6",
    upload: "M12 16V4M6 10l6-6 6 6M5 20h14",
    "zoom-in":
      "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.9-4.9M7.5 10.5h6M10.5 7.5v6",
    hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.6-2.2l-2.8-3.3a1.5 1.5 0 0 1 2.3-1.9L8 15",
    square: "M5 5h14v14H5z",
    pages: "M9 3h8l3 3v11H9zM6 7v14h11",
    "page-none":
      "M15 9V7l-4-4H5v18h6M18 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM15.2 14.2l5.6 5.6",
    "zoom-out":
      "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.9-4.9M7.5 10.5h6",
    check: "M5 12.5l4.5 4.5L19 7.5",
    close: "M6 6l12 12M18 6 6 18",
    search: "M20 20l-3.5-3.5M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
    info: "M12 11v5M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    gear: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    facsimile: "M5 3h14v18H5zM8 8h8M8 12h8M8 16h5",
    notes:
      "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    "side-by-side": "M4 5h7v14H4zM13 5h7v14h-7z",
    warning: "M12 3 2 21h20L12 3zM12 10v5M12 18h.01",
    "check-circle":
      "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8.5 12l2.5 2.5 4.5-5",
    reset: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
    lock: "M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM8 10V7a4 4 0 0 1 8 0v3",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    sort: "M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4",
    clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
    redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
    help: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM9.2 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
    trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v5M13.5 10.5v5",
    "draw-box": "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4",
    comment: "M5 5h14v10h-9l-4 4v-4H5z",
    more: "M5 12h.01M12 12h.01M19 12h.01",
  };
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2.2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : "true"}
  aria-label={label || undefined}
  role={label ? "img" : undefined}
  focusable="false"
>
  <path d={paths[name]} />
</svg>

<style>
  .icon {
    display: inline-block;
    flex: none;
    vertical-align: -0.15em;
  }
</style>
