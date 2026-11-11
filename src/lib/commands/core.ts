// The command core: the context a command runs against, the result it
// resolves to, the command definition, and invoke(), which runs a command and
// commits the history row of a 'direct' command.

import type { ForgeClient } from "../forge/types.ts";
import { appendHistory, HISTORY_PATH } from "../campaign-tables.ts";
import type { HistoryRow } from "../campaign-tables.ts";
import { envelopeColumns } from "../command-envelope.ts";
import type { CommandEnvelope } from "../command-envelope.ts";
import type { ProgressUpdate } from "../run-watch.ts";
import type { OmrModels } from "../omr-page-draft.ts";

const MAX_LOG_ATTEMPTS = 3;

/** What a command invocation is run against: the campaign, the user, the forge. */
export interface CommandContext {
  forge: ForgeClient;
  /** The campaign repo's numeric id — the canonical, rename-stable reference. */
  repoId: number;
  /** The repo id's current owner/name, resolved for the GitHub API paths. */
  owner: string;
  repo: string;
  /** The acting user's numeric account id — written to the tracking tables. */
  viewer: string;
  /** The acting user's login — for human-readable PR prose only, never as an id. */
  viewerLogin: string;
  /** Editor instance used for the mei-friend hand-off; undefined when the deployment sets none. */
  meiFriendUrl?: string;
  /** The OMR models, pinned by version. */
  omr: OmrModels;
  /**
   * Progress for a busy indicator: `step` opens a new stage, `detail` says
   * which part of the running stage is being worked on. Pass a no-op when
   * headless.
   */
  progress: (update: ProgressUpdate) => void;
}

/** The result banner a command resolves to (never rejects). */
export type Result = {
  ok?: boolean;
  /** The command finished in the background: the runner holds no overlay and
   * the PR + verdict are followed through the verdict sink on the task. */
  background?: boolean;
  /** An ok result that is not plainly done: the submission is still being
   * processed ("pending"), there was nothing to do ("noop"), or part of the
   * work failed ("partial"). The banner shows it as a warning. */
  outcome?: "pending" | "noop" | "partial";
  error?: string;
  message?: string;
  prUrl?: string;
  meiFriendUrl?: string;
  /** The mei-friend hand-off waits until the overlay's Continue, so the
   * steps it shows (a draft's warnings) are read before the page is left. */
  holdHandOff?: boolean;
  /** Runs the failed work again; the banner offers it as Try again next to
   * the error. */
  retry?: () => void;
};

interface CommandDef<I, O> {
  id: string;
  version: number;
  log: "pr" | "direct" | "none";
  /** The command resolves to a background result (openAndFinishInBackground):
   * it runs without the busy overlay and its verdict lands through the sink. */
  background?: boolean;
  /** What of the input goes into the envelope; defaults to the input itself. Use to keep bulky payloads (already carried by the PR diff) out of the log. */
  envelopeInput?: (input: I) => Record<string, unknown>;
  run: (
    input: I,
    ctx: CommandContext,
    envelope: CommandEnvelope | null,
  ) => Promise<O>;
}

/**
 * Run a command: build its envelope, execute it, and (for 'direct' commands)
 * append the invocation to the campaign's command log.
 */
export async function invoke<I extends Record<string, unknown>, O>(
  def: CommandDef<I, O>,
  input: I,
  ctx: CommandContext,
): Promise<O> {
  const envelope: CommandEnvelope | null =
    def.log === "none"
      ? null
      : {
          command: def.id,
          version: def.version,
          user_id: ctx.viewer,
          timestamp: new Date().toISOString(),
          input: def.envelopeInput ? def.envelopeInput(input) : input,
        };
  console.log("[command]", def.id, input);
  ctx.progress({
    command: def.id,
    background: def.background,
    task: typeof input.task_id === "string" ? input.task_id : undefined,
  });
  const output = await def.run(input, ctx, envelope);
  if (def.log === "direct" && envelope) {
    const result = output as Result;
    // A command that went through without its history row is partly done.
    if (!(await logDirect(ctx, envelope, result)) && !result?.error) {
      const note = "The command was not recorded in the campaign history.";
      return {
        ...result,
        outcome: result.outcome ?? "partial",
        message: result.message ? `${result.message} ${note}` : note,
      } as O;
    }
  }
  return output;
}

// Commit the command's history row directly (only 'direct' commands, which
// require push access anyway). Returns whether it was committed: a lost log
// row is reported, not fatal — the command itself already succeeded or failed
// on its own terms.
async function logDirect(
  ctx: CommandContext,
  envelope: CommandEnvelope,
  result: Result,
): Promise<boolean> {
  const { forge: f, owner, repo } = ctx;
  const row: HistoryRow = {
    timestamp: envelope.timestamp,
    task_id: String(envelope.input.task_id ?? ""),
    subtask_id: "",
    user_id: envelope.user_id,
    action: "dispatch",
    outcome: result?.error ? "rejected" : "accepted",
    detail: result?.error ?? "",
    ...envelopeColumns(envelope),
  };
  for (let i = 0; i < MAX_LOG_ATTEMPTS; i++) {
    try {
      const { sha } = await f.getRepoHead(owner, repo);
      const csv = await f.getRepoFile(owner, repo, HISTORY_PATH, sha);
      await f.commitFiles(
        owner,
        repo,
        [{ path: HISTORY_PATH, content: appendHistory(csv ?? "", [row]) }],
        `Log command ${envelope.command}`,
        { baseSha: sha },
      );
      return true;
    } catch (e) {
      if (i === MAX_LOG_ATTEMPTS - 1) {
        console.warn(
          `Could not log ${envelope.command} to ${HISTORY_PATH}: ${(e as Error).message}`,
        );
      }
    }
  }
  return false;
}

export type { CommandDef };
