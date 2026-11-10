// Creating the campaign repository, which the wizard's final step does before
// it commits the campaign. Creation is idempotent —
// a repository left behind by an attempt whose response never arrived (a
// network drop after GitHub created it) is adopted on the next try instead of
// failing on the name, and a transient network error is retried once before
// being surfaced.

import type { ForgeClient, RepoData } from "./forge/types.ts";
import { provider } from "./forge/config.ts";
import {
  wizard,
  currentSetup,
  draftSnapshot,
  saveDraft,
  type WizardRepo,
} from "./wizard.svelte.ts";
import { readDraft, writeDraft } from "./wizard-draft.ts";
import { claimName } from "./campaign-resolve.ts";
import type { ProgressUpdate } from "./run-watch.ts";
import { CONFIG_PATH } from "./campaign-tables.ts";
import { sleep } from "./util.ts";

/** A file of the campaign template: a generated repository has contents once it is there. */
const TEMPLATE_MARKER = ".github/workflows/caller.yml";

// A fetch that never reached the server (connection drop, DNS, CORS block)
// surfaces as a TypeError with a browser-worded message, not an API error.
const isNetworkError = (err: unknown): boolean =>
  err instanceof TypeError ||
  /networkerror|failed to fetch|load failed/i.test(
    (err as Error)?.message ?? "",
  );

async function createOrAdoptRepo(
  f: ForgeClient,
  owner: string,
  name: string,
  description: string,
): Promise<RepoData> {
  const create = () =>
    f.createRepoFromTemplate({
      templateOwner: provider.template.owner,
      templateRepo: provider.template.repo,
      owner,
      name,
      description,
      isPrivate: false,
    });
  let error: Error;
  try {
    return await create();
  } catch (err) {
    error = err as Error;
    // The request may have failed on the way back after the repository was
    // created; fall through to look for it. A transient network error with
    // no repository behind it gets one more try below.
  }

  // A lookup that fails says nothing about the repository, so its error is
  // reported rather than taken for "no repository".
  const existing = await f.getRepoInfo(owner, name);
  if (existing) {
    // Adopt it only if GitHub reports it generated from the campaign
    // template; an unrelated repository of the same name must not be
    // committed into.
    const template = `${provider.template.owner}/${provider.template.repo}`;
    if (
      existing.template_repository?.full_name.toLowerCase() ===
      template.toLowerCase()
    ) {
      // Only the final step writes config.yaml, so a repository that has one
      // holds a finished campaign, which a new setup must not take over.
      if ((await f.getRepoFile(owner, name, CONFIG_PATH)) !== null) {
        throw new Error(
          `A campaign already exists in ${owner}/${name}. ` +
            `Restart the setup under another name, or remove or rename that repository.`,
        );
      }
      return existing;
    }
    throw new Error(
      `A repository called ${owner}/${name} already exists but is not this campaign's. ` +
        `Remove or rename it, or restart the setup under another name.`,
    );
  }

  if (isNetworkError(error)) {
    await sleep(1500);
    return create();
  }
  throw error;
}

/**
 * Ensure the campaign repository exists and is ready to be committed to,
 * recording it on the wizard (and its draft) as soon as it does. Reuses the
 * repository a retry or a continued setup already created. Throws with a
 * user-readable message; progress goes to `log`.
 */
export async function ensureCampaignRepo(
  f: ForgeClient,
  userLogin: string,
  log: (update: ProgressUpdate) => void,
): Promise<WizardRepo> {
  // The held name is the campaign's name, for the repository and the registry
  // alike. Without it there is nothing to create the repository under.
  const claim = wizard.claim;
  if (!claim) {
    throw new Error(
      "This campaign has no name reserved yet. Go back to the first step and continue from there.",
    );
  }

  // The repository may already exist from an earlier attempt that failed
  // after creating it; reuse it rather than creating a second one.
  let repo = wizard.repo;
  if (!repo) {
    // Once the repository exists the name is fixed, so a hold that has run
    // out is renewed first: a name taken meanwhile can still be changed.
    if (claim.expiresAt && Date.parse(claim.expiresAt) <= Date.now()) {
      log({ step: `Renewing the reservation of “${claim.name}”` });
      const setup = currentSetup();
      const renewed = await claimName(claim.name);
      if (setup !== currentSetup())
        throw new Error(
          "another setup was opened while this one was being finished",
        );
      if (!("token" in renewed)) {
        throw new Error(
          renewed.error === "taken"
            ? `The reservation of “${claim.name}” ran out and the name was taken by another campaign. Go back to the first step and choose another name.`
            : `The reservation of “${claim.name}” ran out and could not be renewed${"detail" in renewed && renewed.detail ? `: ${renewed.detail}` : ""}. Try again.`,
        );
      }
      wizard.claim = {
        name: claim.name,
        token: renewed.token,
        expiresAt: renewed.expiresAt,
      };
      saveDraft(userLogin, draftSnapshot());
    }
    // The repository's "About" carries the campaign's title and description
    // together. GitHub rejects a description longer than 350 characters.
    const about = [wizard.title.trim(), wizard.description.trim()]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 350);
    log({ step: "Creating the repository" });
    const setup = currentSetup();
    const created = await createOrAdoptRepo(f, userLogin, claim.name, about);
    repo = {
      owner: created.owner.login,
      name: created.name,
      full_name: created.full_name,
      html_url: created.html_url,
      id: created.id,
    };
    // Another setup opened meanwhile: the repository is recorded on this
    // setup's draft only, and the finish stops.
    if (setup !== currentSetup()) {
      const draft = readDraft(userLogin, claim.name);
      if (draft) writeDraft({ ...draft, repo });
      throw new Error(
        "another setup was opened while this one was being finished",
      );
    }
    wizard.repo = repo;
    // The repository exists from here on, whatever happens next. The draft is
    // stored on a debounce as entries change, which is too late for this: a
    // setup continued without it would try to create a second repository
    // under a name this one already has.
    saveDraft(userLogin, draftSnapshot());

    // The listing topic is not stamped here: it marks a campaign, and this
    // repository is not one until the final step has set it up.
  }

  // Generating from a template is asynchronous — wait until the repo has
  // contents before anything commits onto it.
  log({ step: "Waiting for the repository" });
  await f.waitForRepoContents(repo.owner, repo.name, TEMPLATE_MARKER);
  return repo;
}
