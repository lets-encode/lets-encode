// The app command layer: every user-facing campaign operation is a named,
// versioned command with JSON-serialisable input, run through invoke(). The
// UI is one caller among possible others (an agent can drive the same
// registry), and every MUTATING command fills the command columns of one row
// in the campaign's append-only tracking/history.csv:
//   - log 'pr':     the mutation travels as a pull request; the envelope rides
//                   in the PR body and the campaign automation folds it into
//                   the history row it authors for the event (volunteers
//                   cannot write to the campaign repo).
//   - log 'direct': the command mutates without a PR (requires push access);
//                   invoke() commits the history row itself after the command ran.
//   - log 'none':   reads — not logged.
// Handlers are self-contained: they read the tracking tables themselves rather
// than relying on caller state. See DESIGN.md §5 (history.csv) & §6.

export { invoke } from "./commands/core.ts";
export type { CommandContext, Result } from "./commands/core.ts";
export type { FileSource } from "./commands/task-branch.ts";
export {
  RUN_REQUIREMENTS,
  sameKey,
  setVerdictSink,
  resumeFollowing,
} from "./commands/change-request.ts";
export type {
  PendingKey,
  FollowedPr,
  PendingVerdictSink,
} from "./commands/change-request.ts";
export type { CampaignTables } from "./commands/tables.ts";
export type { FailComment } from "./commands/review.ts";
export { commentInput } from "./commands/comments.ts";
export type { CommentAnchorInput } from "./commands/comments.ts";
export type { FacsimileTaskData } from "./commands/pre-task.ts";
export type { DraftInput } from "./commands/drafts.ts";
import { readTables } from "./commands/tables.ts";
import { claimValidation, abandon, claimTask } from "./commands/claim.ts";
import { openEditor } from "./commands/editor.ts";
import { submitEncoding } from "./commands/encoding.ts";
import { reviewEdit, submitValidation } from "./commands/review.ts";
import { submitComment, resolveComment } from "./commands/comments.ts";
import { savePlan, runReaper } from "./commands/maintenance.ts";
import {
  readFacsimile,
  submitZones,
  submitOmrLayout,
  submitScoreSetup,
  submitEncodingAlignment,
} from "./commands/pre-task.ts";
import { saveDraft } from "./commands/drafts.ts";

/** The app command registry. */
export const commands = {
  readTables,
  claimValidation,
  abandon,
  reviewEdit,
  openEditor,
  submitEncoding,
  submitValidation,
  submitComment,
  resolveComment,
  savePlan,
  runReaper,
  readFacsimile,
  claimTask,
  submitZones,
  submitOmrLayout,
  submitScoreSetup,
  submitEncodingAlignment,
  saveDraft,
};
