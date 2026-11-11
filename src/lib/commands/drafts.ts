// Saving a pre-task editor's state as a draft on the viewer's task branch.

import type { FileChange } from "../forge/types.ts";
import {
  parseTaskCsv,
  parseLockCsv,
  findRow,
  LOCK_PATH,
  TASK_PATH,
} from "../campaign-tables.ts";
import { encodingClaimOf } from "../campaign-claim.ts";
import { liveLocks } from "../campaign-reaper.ts";
import type { PageModel, ScoreDefModel } from "../mei-facsimile.ts";
import { correctedLayoutPath, layoutRecordPath } from "../omr-layout.ts";
import type { LayoutInstruments, LayoutRecord } from "../omr-layout.ts";
import { omrRecordPath } from "../omr-record.ts";
import { alignmentPath } from "../encoding-align.ts";
import type { AlignmentChoices, Pin } from "../encoding-align.ts";
import type { CommandDef, Result } from "./core.ts";
import { seedFromKeptWork, workRepoOf } from "./task-branch.ts";
import { alignmentScore, facsimileScore, setupScore } from "./pre-task.ts";

/** A pre-task editor's state, as saveDraft takes it. */
export type DraftInput = {
  task_id: string;
  /** A measure or layout correction's pages. */
  pages?: PageModel[];
  /** The pages are a layout correction's. */
  layout?: boolean;
  /** The layout model's raw output, when detection ran in this session. */
  rawLayout?: LayoutRecord;
  /** The instruments a layout correction named. */
  instruments?: LayoutInstruments;
  /** A score setup's definition. */
  scoreDef?: ScoreDefModel;
  /** A score setup's or a naming layout correction's recognition record, when recognition ran in this session. */
  omr?: string;
  /** An encoding alignment's fixed links. */
  pins?: Pin[];
  /** An encoding alignment's chosen score staves. */
  scoreStaves?: AlignmentChoices["scoreStaves"];
  /** An encoding alignment's file measure edits. */
  fileEdits?: AlignmentChoices["fileEdits"];
  /**
   * The commit of the task branch the editor's state was loaded from or last
   * saved as; null when there was no branch. The save is refused when the
   * branch has moved since, from another tab or device.
   */
  base?: string | null;
};

const DRAFT_CHANGED_ELSEWHERE =
  "The draft was not saved: it was changed in another tab or on another device. Reload the page to continue from that version.";

// Save a pre-task editor's state to the viewer's task branch
// `encode-<task_id>` as the files its submission would carry, so the work
// survives leaving the editor and is kept when the claim expires. A missing
// branch is created from the campaign's head and first given the work kept
// from expired claims, whose side files the state may not repeat. A draft is
// saved only while the viewer holds the task's encoding claim: the end of a
// claim deletes the branch, and a later save would bring it back.
const saveDraft: CommandDef<DraftInput, Result & { sha?: string }> = {
  id: "campaign.saveDraft",
  version: 1,
  log: "none",
  async run(input, ctx) {
    const { forge: f, owner, repo, viewer } = ctx;
    try {
      const [taskCsv, lockCsv] = await Promise.all([
        f.getRepoFile(owner, repo, TASK_PATH),
        f.getRepoFile(owner, repo, LOCK_PATH),
      ]);
      const task = findRow(parseTaskCsv(taskCsv ?? ""), input.task_id, "");
      if (!task) return { error: `Unknown task ${input.task_id}.` };
      const holdsLock =
        encodingClaimOf(
          liveLocks(parseLockCsv(lockCsv ?? "")),
          task.task_id,
          viewer,
        ) !== undefined;
      if (!holdsLock)
        return {
          error: `The draft was not saved: you hold no claim on ${task.task_id}.`,
        };
      const workRepo = await workRepoOf(ctx, task.task_id);
      const ref = `encode-${task.task_id}`;
      const current = await f.getBranchHead(workRepo.owner, workRepo.repo, ref);
      if (current !== (input.base ?? null))
        return { error: DRAFT_CHANGED_ELSEWHERE };
      const files: FileChange[] = [];
      if (input.scoreDef) {
        const { content } = await setupScore(ctx, task, input.scoreDef);
        files.push({ path: task.fragment, content });
        if (input.omr)
          files.push({
            path: omrRecordPath(task.fragment),
            content: input.omr,
          });
      } else if (input.pins) {
        const aligned = await alignmentScore(ctx, task, input.pins, input);
        files.push(
          { path: task.fragment, content: aligned.merged.mei },
          { path: alignmentPath(task.fragment), content: aligned.record },
        );
      } else if (input.pages) {
        const { content, corrected } = await facsimileScore(
          ctx,
          task,
          input.pages,
          Boolean(input.layout),
          input.instruments,
          input.omr,
        );
        files.push({ path: task.fragment, content });
        if (corrected)
          files.push({
            path: correctedLayoutPath(task.fragment),
            content: corrected,
          });
        if (input.rawLayout)
          files.push({
            path: layoutRecordPath(task.fragment),
            content: JSON.stringify(input.rawLayout, null, "\t") + "\n",
          });
        if (input.omr)
          files.push({
            path: omrRecordPath(task.fragment),
            content: input.omr,
          });
      } else return { error: "Nothing to save." };
      if (current === null) {
        const { sha } = await f.getRepoHead(owner, repo);
        try {
          await f.createBranch(workRepo.owner, workRepo.repo, ref, sha);
        } catch (e) {
          if (/already exists/i.test((e as Error).message))
            return { error: DRAFT_CHANGED_ELSEWHERE };
          throw e;
        }
        await seedFromKeptWork(ctx, task, workRepo, ref);
      }
      // On the branch as it was read: a save from elsewhere in between
      // refuses the update rather than being overwritten.
      const sha = await f.commitFiles(
        workRepo.owner,
        workRepo.repo,
        files,
        `Draft of ${task.task_id}`,
        current === null ? { branch: ref } : { branch: ref, baseSha: current },
      );
      return { ok: true, message: "Draft saved.", sha };
    } catch (e) {
      if (/\(422 PATCH /.test((e as Error).message))
        return { error: DRAFT_CHANGED_ELSEWHERE };
      return { error: `The draft was not saved: ${(e as Error).message}` };
    }
  },
};

export { saveDraft };
