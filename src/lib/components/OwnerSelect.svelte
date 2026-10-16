<!--
  The account the campaign repository is created in: the signed-in user's own
  account or one of their organisations. Listing organisations needs the
  read:org scope, which the login does not ask for; "Show my organisations"
  asks GitHub for it in a window of its own (grantOrgsScope), so the setup
  keeps its state. A button showing the chosen owner opens a menu below it, or
  above it where the window has no room below. Keyboard: the arrow keys move
  through the menu, Escape and Tab close it. A press outside, a scroll or a
  resize closes it.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import {
    auth,
    forge,
    grantOrgsScope,
    hasOrgsScope,
  } from "$lib/auth.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import type { OrgSummary } from "$lib/forge/types.ts";
  import { wizard } from "$lib/wizard.svelte.ts";

  let {
    labelId,
    disabled = false,
    title,
    waiting = $bindable(false),
  }: {
    /** The id of the element naming the control. */
    labelId: string;
    disabled?: boolean;
    title?: string;
    /** Set while the GitHub window asking for the organisation list is open. */
    waiting?: boolean;
  } = $props();

  type Orgs =
    | { state: "ungranted" }
    | { state: "waiting" }
    | { state: "blocked" }
    | { state: "declined" }
    | { state: "loading" }
    | { state: "listed"; orgs: OrgSummary[] }
    | { state: "failed"; message: string };
  let orgs = $state<Orgs>({ state: "ungranted" });

  const id = $props.id();
  let open = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLDivElement | null>(null);
  let place = $state({ left: 0, top: 0, above: false });

  const MENU_WIDTH = 300;
  const MENU_ROOM = 320;

  const user = $derived(auth.user);
  const chosenOrg = $derived(
    orgs.state === "listed"
      ? orgs.orgs.find((o) => o.login === wizard.repoOwner)
      : undefined,
  );
  const chosenAvatar = $derived(
    wizard.repoOwner ? chosenOrg?.avatar_url : user?.avatar_url,
  );

  async function loadOrgs() {
    const f = forge();
    if (!f) return;
    orgs = { state: "loading" };
    try {
      orgs = { state: "listed", orgs: await f.listUserOrgs() };
    } catch (e) {
      orgs = { state: "failed", message: (e as Error).message };
    }
  }

  async function grant() {
    close(false);
    orgs = { state: "waiting" };
    waiting = true;
    const granted = await grantOrgsScope();
    waiting = false;
    if (granted === null) orgs = { state: "blocked" };
    else if (!granted) orgs = { state: "declined" };
    else await loadOrgs();
    void show();
  }

  async function show() {
    if (!button) return;
    const box = button.getBoundingClientRect();
    const above =
      window.innerHeight - box.bottom < MENU_ROOM && box.top > MENU_ROOM;
    place = {
      left: Math.max(
        16,
        Math.min(box.left, window.innerWidth - MENU_WIDTH - 16),
      ),
      top: above ? box.top - 6 : box.bottom + 6,
      above,
    };
    open = true;
    // A session that already holds read:org lists the organisations at once.
    if (orgs.state === "ungranted" && hasOrgsScope()) void loadOrgs();
    await Promise.resolve();
    (
      menu?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      menu?.querySelector<HTMLElement>('[role^="menuitem"]')
    )?.focus();
  }
  function close(refocus = true) {
    open = false;
    if (refocus) button?.focus();
  }
  function choose(login: string) {
    wizard.repoOwner = login === user?.login ? "" : login;
    close();
  }
  function menuKey(e: KeyboardEvent) {
    if (e.key === "Tab") return close(false);
    if (e.key === "Escape") {
      e.preventDefault();
      return close();
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [
      ...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }
  function buttonKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      void show();
    }
  }

  // A continued setup with an organisation chosen shows its avatar, which the
  // list carries.
  $effect(() => {
    if (wizard.repoOwner && orgs.state === "ungranted" && hasOrgsScope())
      void loadOrgs();
  });

  // A press outside, a scroll anywhere or a resize closes the menu.
  $effect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu?.contains(target) && !button?.contains(target)) close(false);
    };
    const away = (e: Event) => {
      if (!menu?.contains(e.target as Node)) close(false);
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
  class="input owner-btn"
  aria-haspopup="menu"
  aria-expanded={open}
  aria-controls={open ? `${id}-menu` : undefined}
  aria-labelledby="{labelId} {id}-current"
  {disabled}
  {title}
  onclick={() => (open ? close() : show())}
  onkeydown={buttonKey}
>
  {#if chosenAvatar}
    <img
      class="avatar"
      class:org={wizard.repoOwner !== ""}
      src={chosenAvatar}
      alt=""
    />
  {/if}
  <span class="owner-name" id="{id}-current"
    >{wizard.repoOwner || user?.login}</span
  >
  {#if !disabled}<Icon name="chevron-down" size={14} />{/if}
</button>

{#snippet option(login: string, avatar: string | undefined, isOrg: boolean)}
  {@const on = login === (wizard.repoOwner || user?.login)}
  <button
    type="button"
    class="popup-row"
    role="menuitemradio"
    aria-checked={on}
    onclick={() => choose(login)}
  >
    {#if avatar}<img
        class="avatar"
        class:org={isOrg}
        src={avatar}
        alt=""
      />{/if}
    <span class="popup-row-text">{login}</span>
    {#if on}<span class="tick"><Icon name="check" size={14} /></span>{/if}
  </button>
{/snippet}

{#snippet missing()}
  <div class="sep" role="separator"></div>
  <a
    class="popup-row missing"
    role="menuitem"
    href="{provider.brokerUrl}/app-access"
    target="_blank"
    rel="noopener"
    title="An organisation is listed once it allows Let's Encode!. GitHub's page for this app lists your organisations, with a Request button for each one that does not allow it yet."
  >
    <span class="popup-row-text">Organisation missing? Request access</span>
    <Icon name="external" size={13} />
  </a>
{/snippet}

{#if open && user}
  <div
    bind:this={menu}
    id="{id}-menu"
    class="popup owner-menu"
    class:above={place.above}
    role="menu"
    tabindex="-1"
    aria-labelledby={labelId}
    style:left="{place.left}px"
    style:top="{place.top}px"
    style:width="{MENU_WIDTH}px"
    onkeydown={menuKey}
  >
    <div class="popup-head">Your account</div>
    {@render option(user.login, user.avatar_url, false)}
    <div class="popup-head">Organisations</div>
    {#if orgs.state === "loading"}
      <p class="note" role="status">Loading your organisations…</p>
    {:else if orgs.state === "listed"}
      {#each orgs.orgs as org (org.login)}
        {@render option(org.login, org.avatar_url, true)}
      {:else}
        <p class="note">You are not a member of any organisation.</p>
      {/each}
      {@render missing()}
    {:else if orgs.state === "failed"}
      <p class="note note-err" role="alert">
        Could not list your organisations: {orgs.message}
      </p>
      <button
        type="button"
        class="popup-row action"
        role="menuitem"
        onclick={loadOrgs}
      >
        Try again
      </button>
    {:else}
      {#if orgs.state === "declined"}
        <p class="note note-err" role="alert">
          GitHub did not give access to your organisation list.
        </p>
      {:else if orgs.state === "blocked"}
        <p class="note note-err" role="alert">
          The browser did not open the GitHub window. Allow pop-ups for this
          site and try again.
        </p>
      {/if}
      <button
        type="button"
        class="popup-row action"
        role="menuitem"
        onclick={grant}
      >
        {#if orgs.state === "ungranted" || orgs.state === "waiting"}
          <span>
            <span class="popup-row-text">Show my organisations</span>
            <span class="sub"
              >Opens GitHub to allow Let's Encode! to read your organisation
              memberships.</span
            >
          </span>
        {:else}
          Try again
        {/if}
      </button>
    {/if}
  </div>
{/if}

<style>
  .owner-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 240px;
    text-align: left;
    cursor: pointer;
  }
  .owner-btn[aria-expanded="true"] {
    border-color: var(--accent);
  }
  .owner-btn:disabled {
    cursor: default;
  }
  .owner-btn > :global(.icon) {
    flex: none;
    margin-left: auto;
    color: var(--ink-faint);
  }
  .owner-name {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (max-width: 599px) {
    .owner-btn {
      max-width: none;
    }
  }
  /* GitHub's shapes: people round, organisations rounded squares. */
  .avatar {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
  }
  .avatar.org {
    border-radius: 5px;
  }
  .owner-menu {
    max-width: calc(100vw - 32px);
  }
  .owner-menu.above {
    transform: translateY(-100%);
  }
  .owner-menu:focus {
    outline: none;
  }
  .owner-menu .popup-row {
    gap: 10px;
  }
  .owner-menu .popup-row[aria-checked="true"] {
    font-weight: 600;
  }
  .tick {
    margin-left: auto;
    color: var(--accent);
  }
  .action {
    color: var(--link);
    padding-top: 6px;
    padding-bottom: 6px;
  }
  .sub {
    display: block;
    margin-top: 1px;
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .note {
    margin: 0;
    padding: 8px 10px 10px;
    font-size: 12.5px;
    font-weight: 400;
    line-height: 1.4;
    color: var(--ink-soft);
  }
  .note-err {
    color: var(--danger);
  }
  .sep {
    height: 1px;
    margin: 6px 4px;
    background: var(--line);
  }
  .missing {
    min-height: 40px;
    font-size: 12.5px;
    color: var(--ink-soft);
    text-decoration: none;
  }
  .missing > :global(.icon) {
    flex: none;
    margin-left: auto;
  }
</style>
