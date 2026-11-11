// Encoding submission: the campaign.submitEncoding command, which checks the
// assembled score before it opens the submission pull request.

import { sleep } from "../util.ts";
import {
  parseTaskCsv,
  findRow,
  CONFIG_PATH,
  TASK_PATH,
} from "../campaign-tables.ts";
import { pageOfLocator } from "../campaign-graph.ts";
import { appendEnvelopeToPrBody } from "../command-envelope.ts";
import { assembleSubmission } from "../coordinator-policy.ts";
import { checkMei } from "../mei-check.ts";
import type { CommandDef, Result } from "./core.ts";
import { workRepoOf } from "./task-branch.ts";
import { muteOnce, openAndFinishInBackground } from "./change-request.ts";

// After mei-friend reports the task complete (it only pushes to the task
// branch), open the submission PR that advances the task to validation.
const submitEncoding: CommandDef<{ task_id: string }, Result> = {
  id: "campaign.submitEncoding",
  version: 1,
  log: "pr",
  background: true,
  async run({ task_id }, ctx, envelope) {
    const { forge: f, owner, repo, viewer, viewerLogin } = ctx;
    return openAndFinishInBackground(
      ctx,
      `Encoding of ${task_id}`,
      { kind: "encode", task: task_id },
      async () => {
        await muteOnce(ctx);
        const [{ branch: base }, taskCsv] = await Promise.all([
          f.getRepoHead(owner, repo),
          f.getRepoFile(owner, repo, TASK_PATH),
        ]);
        const tasks = parseTaskCsv(taskCsv ?? "");
        const task = findRow(tasks, task_id, "");
        if (!task) throw new Error(`Unknown task ${task_id}.`);
        // The claim/editor flow put the encoding on `encode-<task_id>` in the
        // repo the claim's pull request came from (workRepoOf).
        const branch = `encode-${task_id}`;
        const workRepo = await workRepoOf(ctx, task_id);
        const inCampaign = workRepo.owner === owner && workRepo.repo === repo;
        const head = inCampaign ? branch : `${workRepo.owner}:${branch}`;
        const forkHead = inCampaign ? undefined : { ...workRepo, branch };
        // The branch holds mei-friend's commits. The score is assembled the way
        // the automation assembles it (assembleSubmission) — a page task
        // contributes only its page, spliced into the campaign's score — and
        // checked against the schema,
        // so a failing submission is refused before a pull request is opened.
        // GitHub's Contents API can briefly lag a push, so the read is retried.
        let forkMei: string | null = null;
        for (let attempt = 1; attempt <= 5 && forkMei == null; attempt++) {
          if (attempt > 1) await sleep(1500);
          forkMei = await f.getRepoFile(
            workRepo.owner,
            workRepo.repo,
            task.fragment,
            branch,
          );
        }
        if (forkMei == null)
          throw new Error(
            `${task.fragment} is missing from the submitted encoding.`,
          );
        const isPageTask = pageOfLocator(task.locator) !== null;
        const [baseMei, configYaml] = await Promise.all([
          f.getRepoFile(owner, repo, task.fragment),
          isPageTask ? f.getRepoFile(owner, repo, CONFIG_PATH) : null,
        ]);
        // The automation records the contribution in the header before its
        // check; this one stands in for it, so the header checked has the
        // same shape.
        let mei: string;
        try {
          mei = assembleSubmission({
            task,
            tasks,
            configYaml,
            baseMei,
            forkMei,
            contributions: [
              {
                name: viewerLogin,
                id: viewer,
                message: `Encoding of ${task_id}`,
                isodate: new Date().toISOString().slice(0, 10),
                application: "mei-friend",
              },
            ],
          });
        } catch (e) {
          throw new Error(
            `${isPageTask ? `page ${task.locator}` : "the encoding"} cannot be joined into ${task.fragment}: ${(e as Error).message}`,
          );
        }
        const meiError = await checkMei(mei);
        if (meiError) {
          throw new Error(
            `the encoding fails the MEI schema check (${meiError}). Fix it in mei-friend and complete the task again.`,
          );
        }
        const body = `Submits the encoding of ${task_id} by ${viewerLogin}, edited in mei-friend. Opened from the app.`;
        console.log("[submitpr] opening PR", { head, base });
        const request = {
          title: `Encoding of ${task_id}`,
          head,
          base,
          body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
        };
        let pr;
        try {
          pr = await f.createPullRequest(owner, repo, request);
        } catch (e) {
          if (!/No commits between/i.test((e as Error).message)) throw e;
          // A task completed without changes can leave the branch at the
          // campaign's head, and GitHub opens no pull request without a
          // commit. A commit of the unchanged score gives it one.
          await f.commitFiles(
            workRepo.owner,
            workRepo.repo,
            [{ path: task.fragment, content: forkMei }],
            `Let's Encode: ${task_id} completed without changes`,
            { branch },
          );
          pr = await f.createPullRequest(owner, repo, request);
        }
        console.log("[submitpr] submission PR opened", pr.number, pr.html_url);
        return { ...pr, head: forkHead, cleanup: "accepted" };
      },
    );
  },
};

export { submitEncoding };
