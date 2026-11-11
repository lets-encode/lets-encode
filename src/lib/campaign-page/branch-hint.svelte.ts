// On the dev server: a campaign whose coordinator runs from a branch other
// than an instance's, while its caller.yml still calls campaign.yml at
// another ref (main for every campaign the app creates), gets the command
// that points both at the branch (scripts/use-branch.ts). The app cannot
// change workflow files itself.
//
// Constructed during a component's initialisation: the effects run for the
// component's lifetime.

import { dev } from "$app/environment";
import { auth, forge } from "../auth.svelte.ts";

const INSTANCE_REFS = ["main", "staging", "testing", "develop"];

export class BranchHint {
  #owner: () => string;
  #repo: () => string;

  hint = $state<{ ref: string; called: string } | null>(null);
  command = $derived.by(
    () =>
      `GH_TOKEN=$(gh auth token -u ${auth.user?.login ?? "<account>"}) node scripts/use-branch.ts ${this.#owner()}/${this.#repo()}`,
  );
  // The same hint as a dialog, once per campaign and browser session: a
  // campaign just created on a branch opens with it.
  dialog = $state<HTMLDialogElement | null>(null);
  copied = $state(false);

  constructor(owner: () => string, repo: () => string) {
    this.#owner = owner;
    this.#repo = repo;
    $effect(() => {
      this.hint = null;
      const f = dev && owner() && repo() ? forge() : null;
      if (!f) return;
      const at = { owner: owner(), repo: repo() };
      Promise.all([
        f.getRepoFile(at.owner, at.repo, "config.yaml"),
        f.getRepoFile(at.owner, at.repo, ".github/workflows/caller.yml"),
      ])
        .then(([config, caller]) => {
          const ref =
            /^automation:\n(?:[ \t].*\n)*?[ \t]+ref:\s*"?([^"\s]+)/m.exec(
              config ?? "",
            )?.[1];
          const called = /campaign\.yml@(\S+)/.exec(caller ?? "")?.[1];
          if (at.owner !== owner() || at.repo !== repo()) return;
          this.hint =
            ref && called && ref !== called && !INSTANCE_REFS.includes(ref)
              ? { ref, called }
              : null;
        })
        .catch(() => {});
    });
    $effect(() => {
      if (!this.hint || !this.dialog || this.dialog.open) return;
      const key = `branch-hint-shown:${owner()}/${repo()}`;
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "1");
      } catch {
        /* without storage the dialog opens on every visit */
      }
      this.copied = false;
      this.dialog.showModal();
    });
  }
}
