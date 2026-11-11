// The campaign page's tracking tables: the read of the tables with its
// sequence guard (CampaignData), and keeping them current — the first read,
// the polling refresh, the read again for a new viewer and after a
// background verdict (TableSync).
//
// Both are constructed during a component's initialisation: their effects
// run for the component's lifetime.

import { auth } from "../auth.svelte.ts";
import { readForge, type CommandRunner } from "../command-runner.svelte.ts";
import type { ForgeClient } from "../forge/types.ts";
import { recordCampaignTitle } from "../campaign-title.svelte.ts";
import { campaignLoadFailure } from "../campaign-resolve.ts";
import { commands, invoke } from "../commands.ts";
import type { CommandContext } from "../commands.ts";
import type {
  TaskRow,
  StateRow,
  LockRow,
  HistoryRow,
  CommentRow,
  PieceRef,
} from "../campaign-tables.ts";
import { liveLocks } from "../campaign-reaper.ts";
import { REFRESH_OK, startAutoRefresh } from "../auto-refresh.ts";
import {
  pendingVerdicts,
  type PendingVerdict,
} from "../pending-verdicts.svelte.ts";

// A table read again replaces the shown one only when its content differs,
// so an unchanged table keeps its identity and nothing derived from it
// recomputes.
const changed = <T>(shown: T, read: T): T =>
  JSON.stringify(shown) === JSON.stringify(read) ? shown : read;

export class CampaignData {
  loading = $state(false);
  loaded = $state(false);
  loadError = $state<string | null>(null);
  notInitialised = $state(false);
  isPrivate = $state(false);
  canPush = $state(false);
  // The login the tables were last read as; null when read logged out.
  readAs: string | null = null;
  taskDefs = $state<TaskRow[]>([]);
  rows = $state<StateRow[]>([]);
  validationColumns = $state<string[]>([]);
  tableLocks = $state<LockRow[]>([]);
  history = $state<HistoryRow[]>([]);
  comments = $state<CommentRow[]>([]);
  pieces = $state<PieceRef[]>([]);
  // Numeric user id → login, for displaying the people the tables reference.
  logins = $state<Record<string, string>>({});
  title = $state("");
  description = $state("");
  license = $state("");
  passThreshold = $state(1);
  allowSelfValidation = $state(false);

  // The clock the board's claim expiries count against, a minute at a time.
  now = $state(Date.now());
  // A lock past its `expires` stops holding its task on the next tick.
  locks = $derived(liveLocks(this.tableLocks, this.now));

  // The default branch's head commit the shown tables were read at; null when
  // it could not be read.
  headSha: string | null = null;

  #loadSeq = 0;
  #campaign: () => string;
  #ctx: (f: ForgeClient) => CommandContext;

  constructor(campaign: () => string, ctx: (f: ForgeClient) => CommandContext) {
    this.#campaign = campaign;
    this.#ctx = ctx;
    $effect(() => {
      const timer = setInterval(() => (this.now = Date.now()), 60_000);
      return () => clearInterval(timer);
    });
  }

  // Read the tracking tables (and privacy/config) for the campaign page. Only the
  // first read shows the loading state; refreshes update the tables in place.
  // A background poll's failed read keeps the shown tables and throws. Of
  // reads that overlap, only the latest one started is shown.
  async load(background = false) {
    const f = readForge();
    // The title is recorded under the name it was read for.
    const name = this.#campaign();
    const seq = ++this.#loadSeq;
    this.readAs = auth.user?.login ?? null;
    if (!this.loaded) this.loading = true;
    if (!background) this.loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, this.#ctx(f));
      if (seq !== this.#loadSeq) return;
      this.headSha = tables.headSha;
      this.notInitialised = tables.notInitialised;
      this.isPrivate = tables.isPrivate;
      this.canPush = tables.canPush;
      this.taskDefs = changed(this.taskDefs, tables.taskDefs);
      this.rows = changed(this.rows, tables.rows);
      this.validationColumns = changed(
        this.validationColumns,
        tables.validationColumns,
      );
      this.tableLocks = changed(this.tableLocks, tables.locks);
      this.history = changed(this.history, tables.history);
      this.comments = changed(this.comments, tables.comments);
      this.pieces = changed(this.pieces, tables.pieces);
      this.logins = changed(this.logins, tables.logins);
      this.title = tables.title;
      recordCampaignTitle(name, tables.title);
      this.description = tables.description;
      this.license = tables.license;
      this.passThreshold = tables.passThreshold;
      this.allowSelfValidation = tables.allowSelfValidation;
      if (!this.notInitialised) {
        console.log(
          "[load] tables loaded:",
          this.taskDefs.length,
          "task(s),",
          this.rows.length,
          "state row(s),",
          this.locks.length,
          "lock(s),",
          this.comments.length,
          "comment(s)",
        );
      }
      this.loaded = true;
    } catch (e) {
      if (seq !== this.#loadSeq) return;
      if (background) throw e;
      this.loadError = campaignLoadFailure(e);
    } finally {
      if (seq === this.#loadSeq) this.loading = false;
    }
  }
}

export interface TableSyncHooks {
  owner: () => string;
  repo: () => string;
  repoId: () => number;
  /** Polling waits while this holds (the plan editor open). */
  held: () => boolean;
  /** The viewer changed: the owner's views are dropped. */
  viewerChanged: () => void;
  /** A background verdict on any campaign settled, before the refresh. */
  settled: (entry: PendingVerdict) => void;
}

export class TableSync {
  refreshStatus = $state(REFRESH_OK);

  constructor(data: CampaignData, runner: CommandRunner, h: TableSyncHooks) {
    // Other people's claims, submissions, verdicts and comments: the tables are
    // read again whenever the default branch has moved since the last read.
    // Logged out, every request counts against the shared per-address limit.
    $effect(() => {
      this.refreshStatus = REFRESH_OK;
      if (!h.owner() || !h.repo()) return;
      return startAutoRefresh({
        interval: () => (auth.user ? 10_000 : 300_000),
        held: () => !data.loaded || data.loading || runner.busy || h.held(),
        poll: async () => {
          const { sha } = await readForge().getRepoHead(h.owner(), h.repo());
          if (sha !== data.headSha) await data.load(true);
        },
        onStatus: (status) => (this.refreshStatus = status),
      });
    });

    $effect(() => {
      if (auth.status !== "loading" && h.owner() && h.repo() && !data.loaded)
        data.load();
    });

    // The push permission and the owner's views belong to the viewer the tables
    // were read as. When the viewer changes (a logout or an expired session),
    // they are dropped at once and the tables are read again as the new viewer.
    $effect(() => {
      if (data.loaded && (auth.user?.login ?? null) !== data.readAs) {
        data.canPush = false;
        h.viewerChanged();
        data.loaded = false;
      }
    });

    // Background verdicts on this campaign refresh the tables when they land —
    // unless a command overlay is up, whose own after-refresh will catch the
    // change, or the campaign isn't resolved (nothing to refresh).
    $effect(() =>
      pendingVerdicts.onSettled((entry) => {
        h.settled(entry);
        if (
          entry.repoId === h.repoId() &&
          !runner.busy &&
          h.owner() &&
          h.repo()
        )
          data.load();
      }),
    );
  }
}
