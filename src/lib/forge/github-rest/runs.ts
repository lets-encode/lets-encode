// Workflow runs: listing and reading runs and their jobs, and dispatching a
// workflow.

import { apiRoot, ghGet, ghSend } from "./request.ts";

/** A workflow run, as far as the app follows it. */
export interface WorkflowRunInfo {
  id: number;
  /** queued | in_progress | completed (GitHub also has waiting/pending states). */
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

/** One job of a workflow run, with its steps in execution order. */
export interface WorkflowJobInfo {
  name: string;
  status: string;
  conclusion: string | null;
  steps: Array<{ name: string; status: string; conclusion: string | null }>;
}

const pickRun = (r: WorkflowRunInfo): WorkflowRunInfo => ({
  id: r.id,
  status: r.status,
  conclusion: r.conclusion ?? null,
  created_at: r.created_at,
  html_url: r.html_url,
});

/**
 * The most recent runs of `workflow`, newest first. `event` narrows to one
 * trigger (e.g. workflow_dispatch), `headSha` to runs of one head commit —
 * which is how the run a PR triggered is found.
 */
export async function listWorkflowRuns(
  token: string,
  owner: string,
  repo: string,
  workflow: string,
  filter: { event?: string; headSha?: string } = {},
): Promise<WorkflowRunInfo[]> {
  // Wide enough that the run being searched for is on the first page even
  // when other runs of the same workflow land in between.
  const params = new URLSearchParams({ per_page: "30" });
  if (filter.event) params.set("event", filter.event);
  if (filter.headSha) params.set("head_sha", filter.headSha);
  const { ok, data } = await ghGet<{
    workflow_runs?: WorkflowRunInfo[];
    message?: string;
  }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?${params}`,
    token,
  );
  if (!ok) throw new Error(data?.message || "Failed to read workflow runs");
  return (data?.workflow_runs ?? []).map(pickRun);
}

/** One workflow run by id. */
export async function getWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowRunInfo> {
  const { ok, data } = await ghGet<WorkflowRunInfo & { message?: string }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/actions/runs/${runId}`,
    token,
  );
  if (!ok) throw new Error(data?.message || "Failed to read workflow run");
  return pickRun(data);
}

/** A workflow run's jobs with their steps, in execution order. */
export async function getWorkflowRunJobs(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowJobInfo[]> {
  const { ok, data } = await ghGet<{
    jobs?: WorkflowJobInfo[];
    message?: string;
  }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    token,
  );
  if (!ok) throw new Error(data?.message || "Failed to read workflow run jobs");
  return (data?.jobs ?? []).map((j) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion ?? null,
    steps: (j.steps ?? []).map((s) => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion ?? null,
    })),
  }));
}

/** Manually trigger a workflow_dispatch run of `workflow` (a filename) on `ref`. */
export async function dispatchWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflow: string,
  ref: string,
): Promise<void> {
  await ghSend(
    "POST",
    `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
    token,
    { ref },
  );
}
