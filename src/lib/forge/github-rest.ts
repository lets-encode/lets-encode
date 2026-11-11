// GitHub REST adapter — the raw calls behind the ForgeClient interface (and the
// scripts run by the campaign automation). Every function takes an access token
// explicitly; no client secret lives here. In the browser the real OAuth token
// never exists: pass the SESSION sentinel instead and calls are routed through
// the broker's /proxy, which attaches the token server-side from the session
// cookie. A real token (CI scripts) or no token (anonymous public reads) goes
// straight to the API. Browser- and Node-safe (fetch / atob / TextDecoder).

export {
  WEB,
  SESSION,
  routeSessionVia,
  onSessionRejected,
  RELAY_RETRY_WAITS_MS,
  minuteClock,
  fromUpstream,
  brokerFetch,
  RateLimitError,
  ApiError,
  isTransientError,
  getGitHubRequestTelemetry,
  resetGitHubRequestTelemetry,
} from "./github-rest/request.ts";
export type { GitHubRequestTelemetry } from "./github-rest/request.ts";
export type {
  FileChange,
  GitHubUser,
  RepoData,
  RepoSummary,
  RepoRef,
} from "./github-rest/shapes.ts";
export { clearRequestCaches } from "./github-rest/caches.ts";
export {
  getAuthenticatedUser,
  getUserLogin,
  getCollaboratorCanPush,
} from "./github-rest/users.ts";
export {
  getRepoById,
  createRepoFromTemplate,
  repoExists,
  getRepoInfo,
  getRepoAccess,
  waitForRepoContents,
  setRepoTopics,
  getRepoSubscription,
  ignoreRepoNotifications,
  searchReposByTopic,
} from "./github-rest/repos.ts";
export {
  encodeRepoPath,
  getRepoFile,
  getRepoFilesBatch,
  getRepoFileBytes,
  getRepoFileDownloadUrl,
  getDirDownloadUrls,
} from "./github-rest/files.ts";
export type { RepoFiles } from "./github-rest/files.ts";
export {
  getRepoHead,
  commitFiles,
  getBranchHead,
  createBranch,
  fastForwardBranch,
  listBranchCommitTimes,
  deleteBranch,
} from "./github-rest/commits.ts";
export { ForkDivergedError, ensureFork } from "./github-rest/forks.ts";
export {
  getPullRequestCommitMessages,
  getPullRequestDetails,
  compareCommitMessages,
  getPullRequestFiles,
  getPullRequest,
  listOpenPullRequests,
  getPullRequestState,
  getLastIssueComment,
  closePullRequest,
  commentAndClosePr,
  createPullRequest,
  openChangePr,
} from "./github-rest/pulls.ts";
export type { PullRequestFile, OpenPullRequest } from "./github-rest/pulls.ts";
export {
  listWorkflowRuns,
  getWorkflowRun,
  getWorkflowRunJobs,
  dispatchWorkflow,
} from "./github-rest/runs.ts";
export type { WorkflowRunInfo, WorkflowJobInfo } from "./github-rest/runs.ts";
