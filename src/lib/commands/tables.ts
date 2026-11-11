// Reading the campaign's tracking tables and config: the shared table read and
// the campaign.readTables command.

import type { ForgeClient } from "../forge/types.ts";
import { RateLimitError } from "../forge/github-rest.ts";
import {
  parseTaskCsv,
  parseStateCsv,
  parseLockCsv,
  parseHistoryCsv,
  parseCommentCsv,
  configString,
  passThresholdOf,
  configFlag,
  configPieces,
  resolveLogins,
  COMMENT_PATH,
  CONFIG_PATH,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
} from "../campaign-tables.ts";
import type {
  TaskRow,
  StateRow,
  LockRow,
  HistoryRow,
  CommentRow,
  PieceRef,
} from "../campaign-tables.ts";
import { liveLocks } from "../campaign-reaper.ts";
import type { CommandContext, CommandDef } from "./core.ts";
import { verdictSink } from "./change-request.ts";

/** The parsed campaign tables (and privacy/config) the campaign page renders. */
export interface CampaignTables {
  notInitialised: boolean;
  isPrivate: boolean;
  canPush: boolean;
  taskDefs: TaskRow[];
  rows: StateRow[];
  validationColumns: string[];
  locks: LockRow[];
  history: HistoryRow[];
  /** The comment log (fail explanations and discussion); [] when comment.csv is absent. */
  comments: CommentRow[];
  /** The campaign's pieces from config.yaml, in config order; [] when unreadable. */
  pieces: PieceRef[];
  /** campaign.title from config.yaml; '' when unreadable. */
  title: string;
  /** campaign.description from config.yaml; '' when unreadable or unset. */
  description: string;
  /** campaign.license from config.yaml; '' when unreadable. */
  license: string;
  /** validation.pass_threshold from config.yaml, capped by the slot count; the slot count when unreadable. */
  passThreshold: number;
  /** validation.allow_self_validation from config.yaml; false when unreadable. */
  allowSelfValidation: boolean;
  /**
   * Numeric account id → current login, for every user referenced by the
   * tables (locks, encoders, history). The tables store the stable numeric id;
   * this map is how the UI shows a username. Missing entries fall back to the id.
   */
  logins: Record<string, string>;
  /** The default branch head the tables were read at; null when unknown. */
  headSha: string | null;
}

/** The tracking tables and config, as readTableFiles reads them. */
const TABLE_PATHS = [
  TASK_PATH,
  STATE_PATH,
  LOCK_PATH,
  HISTORY_PATH,
  COMMENT_PATH,
  CONFIG_PATH,
];

interface TableFiles {
  headSha: string | null;
  isPrivate: boolean;
  canPush: boolean;
  /** TABLE_PATHS → text; null where the file does not exist. */
  files: Record<string, string | null>;
}

// Table reads in flight, by forge client and repo. Commands that read the
// tables at the same time through the same client share one read.
const tableReadsInFlight = new WeakMap<
  ForgeClient,
  Map<string, Promise<TableFiles>>
>();

/**
 * The campaign's tables and config with the repo's access, in one batch read
 * where the forge client can, else one read per file.
 */
function readTableFiles(ctx: CommandContext): Promise<TableFiles> {
  let reads = tableReadsInFlight.get(ctx.forge);
  if (!reads) tableReadsInFlight.set(ctx.forge, (reads = new Map()));
  const key = `${ctx.owner}/${ctx.repo}`;
  const pending = reads.get(key);
  if (pending) return pending;
  const read = fetchTableFiles(ctx).finally(() => reads.delete(key));
  reads.set(key, read);
  return read;
}

async function fetchTableFiles({
  forge: f,
  owner,
  repo,
}: CommandContext): Promise<TableFiles> {
  try {
    const [read] =
      (await f.getRepoFilesBatch([{ owner, repo }], TABLE_PATHS)) ?? [];
    if (read) return { ...read, headSha: read.headSha || null };
  } catch (err) {
    // The per-file reads pass through the broker too.
    if (err instanceof RateLimitError && err.source === "broker") throw err;
  }
  // The files are read at the head commit, so they match `headSha` even where
  // the Contents API lags a branch update; without a head they are read at the
  // default branch.
  let headSha: string | null;
  try {
    headSha = (await f.getRepoHead(owner, repo)).sha;
  } catch {
    headSha = null;
  }
  const [access, ...contents] = await Promise.all([
    f.getRepoAccess(owner, repo),
    ...TABLE_PATHS.map((path) =>
      f.getRepoFile(owner, repo, path, headSha ?? undefined),
    ),
  ]);
  return {
    headSha,
    ...access,
    files: Object.fromEntries(TABLE_PATHS.map((p, i) => [p, contents[i]])),
  };
}

const readTables: CommandDef<Record<string, never>, CampaignTables> = {
  id: "campaign.readTables",
  version: 1,
  log: "none",
  async run(_input, ctx) {
    const { forge: f } = ctx;
    const { headSha, files, ...access } = await readTableFiles(ctx);
    const [taskCsv, stateCsv, lockCsv, historyCsv, commentCsv, configYaml] =
      TABLE_PATHS.map((path) => files[path]);
    if (taskCsv == null || stateCsv == null || lockCsv == null) {
      return {
        notInitialised: true,
        isPrivate: access.isPrivate,
        canPush: access.canPush,
        taskDefs: [],
        rows: [],
        validationColumns: [],
        locks: [],
        history: [],
        comments: [],
        pieces: [],
        title: "",
        description: "",
        license: "",
        passThreshold: 1,
        allowSelfValidation: false,
        logins: {},
        headSha,
      };
    }
    const state = parseStateCsv(stateCsv);
    // A lock past its `expires` no longer holds the task.
    const locks = liveLocks(parseLockCsv(lockCsv));
    const history = historyCsv ? parseHistoryCsv(historyCsv) : [];
    verdictSink.recorded(
      ctx.repoId,
      new Set(history.flatMap((row) => (row.pr ? [Number(row.pr)] : []))),
    );
    const comments = commentCsv ? parseCommentCsv(commentCsv) : [];
    return {
      notInitialised: false,
      isPrivate: access.isPrivate,
      canPush: access.canPush,
      taskDefs: parseTaskCsv(taskCsv),
      rows: state.rows,
      validationColumns: state.validationColumns,
      locks,
      history,
      comments,
      pieces: configPieces(configYaml),
      title: configString(configYaml, "title"),
      description: configString(configYaml, "description"),
      license: configString(configYaml, "license"),
      passThreshold: passThresholdOf(
        configYaml,
        state.validationColumns.length,
      ),
      allowSelfValidation: configFlag(configYaml, "allow_self_validation"),
      logins: await resolveLogins((n) => f.getUserLogin(n), {
        rows: state.rows,
        locks,
        history,
        comments,
      }),
      headSha,
    };
  },
};

export { readTableFiles, readTables };
