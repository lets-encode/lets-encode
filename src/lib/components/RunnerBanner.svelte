<!--
  The result line of a page's last command (Notice): its error, or its
  message when it finished in the foreground, with the submission link and,
  outside a task box (inline), a Dismiss. An error whose result carries a
  retry offers Try again.
  A mei-friend hand-off also shows the link to open mei-friend by hand, for
  when the browser blocked the new tab.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import Notice, { splitMessage } from "$lib/components/Notice.svelte";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";

  let {
    runner,
    surface = "card",
    isPrivate = false,
    retryable = true,
  }: {
    runner: CommandRunner;
    surface?: "inline" | "card" | "strip";
    /** The campaign repo is private: the mei-friend link carries access. */
    isPrivate?: boolean;
    /** The page allows the result's retry now. */
    retryable?: boolean;
  } = $props();
  const result = $derived(runner.result);
  const text = $derived(
    splitMessage(result ? (result.error ?? result.message ?? "") : ""),
  );

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});
</script>

<!-- A live region that is always present, so a result appearing in it is
     announced; empty, it takes no room. -->
<div class="live" role="status">
  {#if result && (result.error || (result.ok && !result.background))}
    <Notice
      tone={result.error ? "err" : result.outcome ? "warn" : "ok"}
      {surface}
      live={false}
      title={text.title}
      detail={text.detail}
      action={result.error && result.retry && retryable
        ? { label: "Try again", run: result.retry, disabled: runner.busy }
        : undefined}
      ondismiss={surface === "inline"
        ? undefined
        : () => (runner.result = null)}
    >
      {#if result.prUrl}
        <a href={result.prUrl} target="_blank" rel="noreferrer"
          >View submission <Icon name="external" size={12} /></a
        >
      {/if}
      {#if !result.error && result.meiFriendUrl}
        <div class="rawlink">
          <input
            readonly
            aria-label="mei-friend link"
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
    </Notice>
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
  .rawlink {
    display: flex;
    gap: 0.4rem;
    margin-top: 4px;
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
