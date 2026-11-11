// Comments and their resolution: the campaign.submitComment and
// campaign.resolveComment commands.

import { shortId } from "../util.ts";
import {
  parseCommentCsv,
  serializeCommentCsv,
  appendComments,
  COMMENT_PATH,
} from "../campaign-tables.ts";
import { resolveCommentThread } from "../campaign-submit.ts";
import { appendEnvelopeToPrBody } from "../command-envelope.ts";
import type { CommandDef, Result } from "./core.ts";
import {
  muteOnce,
  openAndFinishInBackground,
  readAtHead,
} from "./change-request.ts";

// Open a PR that appends one discussion comment (comment / reply)
// to comment.csv. The Action re-authors id, author and timestamp.
/** A measure anchor; `fragment` names the piece on a campaign comment. */
export interface CommentAnchorInput {
  page: string;
  measure_start: string;
  measure_end: string;
  fragment?: string;
}

/** The submitComment input for a task comment, or a campaign comment when
    `task_id` is '', anchored at `at` when given. */
export const commentInput = (
  task_id: string,
  kind: string,
  body: string,
  parent_id: string,
  at?: CommentAnchorInput,
) => ({
  task_id,
  subtask_id: "",
  kind,
  body,
  page: at?.page ?? "",
  measure_start: at?.measure_start ?? "",
  measure_end: at?.measure_end ?? "",
  fragment: at?.fragment ?? "",
  parent_id,
});

const submitComment: CommandDef<
  {
    task_id: string;
    subtask_id: string;
    kind: string;
    body: string;
    page: string;
    measure_start: string;
    measure_end: string;
    fragment: string;
    parent_id: string;
  },
  Result
> = {
  id: "campaign.submitComment",
  version: 1,
  log: "pr",
  background: true,
  envelopeInput: ({ task_id, subtask_id, kind, parent_id }) => ({
    task_id,
    subtask_id,
    kind,
    parent_id,
  }),
  async run(input, ctx, envelope) {
    const { forge: f, owner, repo } = ctx;
    if (!input.body.trim())
      return { error: "The comment is empty — nothing was sent." };
    const target = input.task_id || "the campaign";
    return openAndFinishInBackground(
      ctx,
      `Comment on ${target}`,
      { kind: "comment", task: input.task_id },
      async () => {
        await muteOnce(ctx);
        const {
          sha,
          files: [commentCsv],
        } = await readAtHead(ctx, [COMMENT_PATH]);
        const content = appendComments(commentCsv ?? "", [
          {
            comment_id: "",
            task_id: input.task_id,
            subtask_id: input.subtask_id,
            kind: input.kind,
            page: input.page,
            measure_start: input.measure_start,
            measure_end: input.measure_end,
            author_id: "",
            timestamp: "",
            resolved: "",
            parent_id: input.parent_id,
            body: input.body.trim(),
            fragment: input.fragment,
          },
        ]);
        const body = `Adds a ${input.kind} on ${target}. Opened from the app.`;
        const pr = await f.openChangePr(owner, repo, {
          branch: `comment-${input.task_id || "campaign"}-${shortId()}`,
          files: [{ path: COMMENT_PATH, content }],
          message: `Comment on ${target} (${input.kind})`,
          title: `Comment on ${target} (${input.kind})`,
          body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
          baseSha: sha,
        });
        console.log("[comment] comment PR opened", pr.number, pr.html_url);
        return pr;
      },
    );
  },
};

// Open a PR that marks one comment resolved (author or push access only —
// the automation enforces it).
const resolveComment: CommandDef<{ comment_id: string }, Result> = {
  id: "campaign.resolveComment",
  version: 1,
  log: "pr",
  background: true,
  async run({ comment_id }, ctx, envelope) {
    const { forge: f, owner, repo } = ctx;
    let comments;
    let sha: string;
    try {
      const read = await readAtHead(ctx, [COMMENT_PATH]);
      sha = read.sha;
      comments = parseCommentCsv(read.files[0] ?? "");
    } catch (e) {
      return { error: `Resolve failed: ${(e as Error).message}` };
    }
    const row = comments.find((c) => c.comment_id === comment_id);
    if (!row) return { error: `Unknown comment ${comment_id}.` };
    if (row.resolved === "true")
      return { ok: true, outcome: "noop", message: "Already resolved." };
    // A resolved comment takes its replies with it (the automation enforces
    // the same on its side).
    const resolved = resolveCommentThread(comments, comment_id);
    // Keyed by comment, not task: the run state renders on the comment's
    // card (CommentCard and friends), not on the task's run state.
    return openAndFinishInBackground(
      ctx,
      `Resolution of comment ${comment_id}`,
      { kind: "resolve", task: row.task_id, comment: comment_id },
      async () => {
        await muteOnce(ctx);
        const body = `Resolves comment ${comment_id} on ${row.task_id || "the campaign"}. Opened from the app.`;
        const pr = await f.openChangePr(owner, repo, {
          branch: `resolve-${comment_id}-${shortId()}`,
          files: [
            { path: COMMENT_PATH, content: serializeCommentCsv(resolved) },
          ],
          message: `Resolve comment ${comment_id}`,
          title: `Resolve comment ${comment_id}`,
          body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
          baseSha: sha,
        });
        console.log("[comment] resolve PR opened", pr.number, pr.html_url);
        return pr;
      },
    );
  },
};

export { resolveComment, submitComment };
