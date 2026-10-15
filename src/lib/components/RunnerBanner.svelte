<!--
  The result banner of a page's last command: its error, or its message when
  it finished in the foreground, with the submission link and a Dismiss, or
  (collapsible) an arrow that folds it to one line and back.
  A mei-friend hand-off also shows the link to open mei-friend by hand, for
  when the browser blocked the new tab.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";

  let {
    runner,
    bar = false,
    isPrivate = false,
    collapsible = false,
  }: {
    runner: CommandRunner;
    /** A full-width strip flush against its container. */
    bar?: boolean;
    /** The campaign repo is private: the mei-friend link carries access. */
    isPrivate?: boolean;
    /** Folds to one line by an arrow instead of being dismissed. */
    collapsible?: boolean;
  } = $props();
  const result = $derived(runner.result);
  // Each new result opens unfolded.
  let collapsed = $state(false);
  $effect(() => {
    void result;
    collapsed = false;
  });

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});
</script>

<!-- A live region that is always present, so a result appearing in it is
     announced; empty, it takes no room. -->
<div class="live" role="status">
  {#if result && (result.error || (result.ok && !result.background))}
    <div
      class="banner {result.error ? 'err' : result.warn ? 'warn' : 'ok'}"
      class:bar
      class:collapsed
    >
      <div class="banner-body">
        <span class="message">
          {result.error ?? result.message}
          {#if result.prUrl}
            <a href={result.prUrl} target="_blank" rel="noreferrer"
              >View submission <Icon name="external" size={12} /></a
            >
          {/if}
        </span>
        {#if !collapsed && !result.error && result.meiFriendUrl}
          <div class="rawlink">
            <input
              readonly
              value={result.meiFriendUrl}
              onfocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button type="button" onclick={() => copy(result.meiFriendUrl!)}
              >Copy</button
            >
          </div>
          <span class="muted">
            <a href={result.meiFriendUrl}
              >Open in mei-friend <Icon name="external" size={12} /></a
            >
          </span>
          {#if isPrivate}
            <span class="muted">
              Opening mei-friend shares a short-lived, read-capable GitHub URL
              with that external service.
            </span>
          {/if}
        {/if}
      </div>
      {#if collapsible}
        <button
          type="button"
          class="fold"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show the whole message" : "Fold the message"}
          title={collapsed ? "Show the whole message" : "Fold the message"}
          onclick={() => (collapsed = !collapsed)}
          ><Icon name={collapsed ? "chevron-down" : "chevron-up"} /></button
        >
      {:else}
        <button
          type="button"
          class="dismiss"
          onclick={() => (runner.result = null)}>Dismiss</button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .live:empty {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .muted {
    color: var(--ink-faint);
  }
  .collapsed .message {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fold {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin: -2px -4px -2px 0;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }
  @media (hover: hover) {
    .fold:hover {
      opacity: 1;
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
  }
  .rawlink {
    display: flex;
    gap: 0.4rem;
  }
  .rawlink input {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
  }
  .rawlink button {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
    cursor: pointer;
  }
</style>
