// The facsimile pre-tasks (zone editor): reading a pre-task, and submitting a
// measure or layout correction, a score setup or an encoding alignment.

import { shortId } from "../util.ts";
import type { FileChange, OpenedChangeRequest } from "../forge/types.ts";
import {
  parseTaskCsv,
  parseStateCsv,
  parseLockCsv,
  findRow,
  CONFIG_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
  configPieceRegions,
} from "../campaign-tables.ts";
import type { TaskRow, PageRegion } from "../campaign-tables.ts";
import { usesOmr } from "../campaign-init.ts";
import { waitsFor } from "../campaign-claim.ts";
import { liveLocks } from "../campaign-reaper.ts";
import { appendEnvelopeToPrBody } from "../command-envelope.ts";
import type { CommandEnvelope } from "../command-envelope.ts";
import {
  parseFacsimileMei,
  buildFacsimileMei,
  buildBlankScoreMei,
  replaceScoreDef,
} from "../mei-facsimile.ts";
import type {
  PageModel,
  ParsedFacsimile,
  ScoreDefModel,
} from "../mei-facsimile.ts";
import { pieceFieldForPath, pieceKindForPath } from "../coordinator-policy.ts";
import {
  resolveFacsimileImageUrls,
  resolveRepoRelativeTarget,
} from "../facsimile-images.ts";
import { checkMei } from "../mei-check.ts";
import {
  correctedLayoutJson,
  correctedLayoutPath,
  layoutInstruments,
  layoutRecordPath,
  withCorrectedLayout,
} from "../omr-layout.ts";
import type { LayoutInstruments, LayoutRecord } from "../omr-layout.ts";
import { omrRecordPath, parseOmrRecord } from "../omr-record.ts";
import { alignmentPath, differentReason } from "../encoding-align.ts";
import type { AlignmentChoices, Pin } from "../encoding-align.ts";
import { alignEncoding, alignmentMessage } from "../encoding-merge.ts";
import {
  instrumentScoreDef,
  openingTranscriptions,
} from "../instrument-naming.ts";
import type { CommandContext, CommandDef, Result } from "./core.ts";
import { workSource } from "./task-branch.ts";
import type { FileSource } from "./task-branch.ts";
import { muteOnce, openAndFinishInBackground } from "./change-request.ts";
import { readTableFiles } from "./tables.ts";

/** Whether a score holds notation in its measures rather than seeds or empty layers. */
const hasNotation = (mei: string): boolean =>
  /<(note|rest|chord|space|beam|tuplet)\b/.test(mei);

/** Everything the zone editor needs about a facsimile pre-task. */
export interface FacsimileTaskData {
  model: ParsedFacsimile;
  /** Per page (same order as model.pages), a direct download URL for its image. */
  imageUrls: string[];
  fragment: string;
  locator: string;
  /** The piece's preparation from config.yaml, one of PREPARATIONS. */
  preparation: string;
  /** Per page (same order as model.pages), the piece's regions on it from
      config.yaml, in image pixels; empty where the config gives none. */
  regions: PageRegion[][];
  /** Whether the score holds any notation (notes, rests, chords). */
  hasNotation: boolean;
  status: string;
  /** Whether the viewer holds the task's active encoding lock (may edit/submit). */
  holdsLock: boolean;
  /** Who holds the task's active encoding lock ('' when unclaimed). */
  encodingLockUser: string;
  /** When that lock runs out (ISO); '' when unclaimed. */
  encodingLockExpires: string;
  /** Where the score was read from when not from `main`: the holder's saved
      work or the work kept from expired claims. */
  workSource: FileSource | null;
  /** The commit of the viewer's task branch the editor opens on; null when
      the branch does not exist. A draft is saved on top of it only. */
  draftBase: string | null;
  /** The incomplete task this one waits for (task.csv depends_on); '' when none. */
  blockedBy: string;
  /** The instruments a layout task named (layout-corrected.json); null when none. */
  instruments: LayoutInstruments | null;
  /** For an encoding alignment, the uploaded encoding; null otherwise. */
  upload: string | null;
  /**
   * For an encoding alignment, the alignment record (alignment.json) where
   * the score was read from; null when there is none.
   */
  alignment: string | null;
  /**
   * For an encoding alignment, the piece's score in the campaign and its
   * corrected layout, which the alignment is made on; null otherwise.
   */
  campaignScore: { mei: string; corrected: string | null } | null;
}

const readFacsimile: CommandDef<{ task_id: string }, FacsimileTaskData> = {
  id: "campaign.readFacsimile",
  version: 1,
  log: "none",
  async run({ task_id }, ctx) {
    const { forge: f, owner, repo, viewer } = ctx;
    const { files } = await readTableFiles(ctx);
    const [taskCsv, stateCsv, lockCsv, configYaml] = [
      TASK_PATH,
      STATE_PATH,
      LOCK_PATH,
      CONFIG_PATH,
    ].map((path) => files[path]);
    const task = findRow(parseTaskCsv(taskCsv ?? ""), task_id, "");
    if (!task) throw new Error(`Unknown task ${task_id}.`);
    const preparation =
      pieceFieldForPath(configYaml, task.fragment, "preparation") ??
      "measure-detection";
    const locks = liveLocks(parseLockCsv(lockCsv ?? ""));
    const encodingLock = locks.find(
      (l) =>
        l.task_id === task_id && l.subtask_id === "" && l.kind === "encoding",
    );
    const holdsLock = viewer !== "" && encodingLock?.user_id === viewer;
    const state = parseStateCsv(stateCsv ?? "");
    const taskState = findRow(state.rows, task_id, "");
    // The claim holder's editor opens on their saved work, else on the work
    // kept from expired claims, else on the campaign's score.
    const source =
      holdsLock && taskState?.status === "encoding_required"
        ? await workSource(ctx, task)
        : null;
    const from = source ?? { owner, repo, ref: undefined };
    const [mei, corrected] = await Promise.all([
      f.getRepoFile(from.owner, from.repo, task.fragment, from.ref),
      usesOmr(preparation)
        ? f.getRepoFile(
            from.owner,
            from.repo,
            correctedLayoutPath(task.fragment),
            from.ref,
          )
        : null,
    ]);
    if (mei == null) throw new Error(`Could not read ${task.fragment}.`);
    const model = parseFacsimileMei(mei);
    if (usesOmr(preparation))
      model.pages = withCorrectedLayout(model.pages, corrected);
    const instruments = corrected ? layoutInstruments(corrected) : null;
    const aligning = task.locator === "encoding-align";
    const [upload, alignment, campaignScore] = aligning
      ? await alignmentInputs(ctx, task, configYaml, from)
      : [null, null, null];
    const imageUrls = await resolveFacsimileImageUrls(
      f,
      owner,
      repo,
      task.fragment,
      model.pages.map((page) => page.image),
    );
    const blockedBy = waitsFor(
      task.depends_on,
      (t) => findRow(state.rows, t, "")?.status,
    );
    return {
      model,
      imageUrls,
      fragment: task.fragment,
      locator: task.locator,
      preparation,
      regions: configPieceRegions(
        configYaml,
        task.fragment,
        model.pages.map((page) =>
          resolveRepoRelativeTarget(task.fragment, page.image),
        ),
      ),
      hasNotation: hasNotation(mei),
      status: taskState?.status ?? "",
      holdsLock,
      encodingLockUser: encodingLock?.user_id ?? "",
      encodingLockExpires: encodingLock?.expires ?? "",
      workSource: source,
      draftBase: source?.sha ?? null,
      blockedBy,
      instruments,
      upload,
      alignment,
      campaignScore,
    };
  },
};

/** An encoding alignment's files: the upload, the alignment record where
    the score is read from, and the campaign's score and corrected layout. */
async function alignmentInputs(
  ctx: CommandContext,
  task: TaskRow,
  configYaml: string | null,
  from: { owner: string; repo: string; ref: string | undefined },
): Promise<[string, string | null, { mei: string; corrected: string | null }]> {
  const { forge: f, owner, repo } = ctx;
  const path = pieceFieldForPath(configYaml, task.fragment, "encoding");
  if (!path) throw new Error(`${task.fragment} has no uploaded encoding.`);
  const omr = usesOmr(
    pieceFieldForPath(configYaml, task.fragment, "preparation"),
  );
  const [upload, alignment, mei, corrected] = await Promise.all([
    f.getRepoFile(owner, repo, path),
    f.getRepoFile(
      from.owner,
      from.repo,
      alignmentPath(task.fragment),
      from.ref,
    ),
    f.getRepoFile(owner, repo, task.fragment),
    omr ? f.getRepoFile(owner, repo, correctedLayoutPath(task.fragment)) : null,
  ]);
  if (upload == null) throw new Error(`Could not read ${path}.`);
  if (mei == null) throw new Error(`Could not read ${task.fragment}.`);
  return [upload, alignment, { mei, corrected }];
}

// Check and build the rewritten score, then open its PR in the background;
// the verdict lands on the task's run state. The current file's <meiHead> is
// carried over verbatim, its score definition through the parse.
//
// The submission advances the score to stage C (generated measures, breaks and
// movements). A submission that changes no file is opened as well: it
// confirms the boxes as they are, and the coordinator reads the score from
// the pull request's head whether or not it changed.
//
// A layout submission (an OMR-prepared piece) writes its measure zones with a
// margin and leaves the measures empty: the notation comes from transcription
// later. Its tight measure, staff and grand-staff boxes go to
// `layout-corrected.json`.
// The score a measure or layout correction's pages amount to, built on the
// campaign's current score, and for a layout correction its corrected boxes.
// A layout correction that names the instruments also gives the score its
// staves (instrumentScoreDef), with the clefs, key and meter proposed from its
// recognition record `omr` where it has one.
async function facsimileScore(
  ctx: CommandContext,
  task: TaskRow,
  pages: PageModel[],
  layout: boolean,
  instruments?: LayoutInstruments,
  omr?: string | null,
): Promise<{ content: string; corrected: string | null }> {
  const { forge: f, owner, repo } = ctx;
  const current = await f.getRepoFile(owner, repo, task.fragment);
  if (current == null) throw new Error(`Could not read ${task.fragment}.`);
  const parsed = parseFacsimileMei(current);
  const record = instruments && omr ? parseOmrRecord(omr) : null;
  return {
    content: buildFacsimileMei(
      {
        headXml: parsed.headXml,
        scoreDef: instruments
          ? instrumentScoreDef(
              instruments,
              parsed.scoreDef,
              pages,
              record
                ? openingTranscriptions(instruments, pages, record)
                : undefined,
            )
          : parsed.scoreDef,
        pages,
      },
      { withBreaks: true, emptyMeasures: layout, padZones: layout },
    ),
    corrected: layout ? correctedLayoutJson(pages, instruments) : null,
  };
}

// A side file of the viewer's saved work (or of the work kept from expired
// claims) that differs from the campaign's; null when there is none.
async function savedSideFile(
  ctx: CommandContext,
  task: TaskRow,
  path: string,
): Promise<string | null> {
  const { forge: f, owner, repo } = ctx;
  const source = await workSource(ctx, task);
  if (!source) return null;
  const [saved, campaign] = await Promise.all([
    f.getRepoFile(source.owner, source.repo, path, source.ref),
    f.getRepoFile(owner, repo, path),
  ]);
  return saved != null && saved !== campaign ? saved : null;
}

async function submitFacsimile(
  ctx: CommandContext,
  task_id: string,
  pages: PageModel[],
  envelope: CommandEnvelope | null,
  layout = false,
  rawLayout?: LayoutRecord,
  instruments?: LayoutInstruments,
  omr?: string,
): Promise<Result> {
  const { forge: f, owner, repo } = ctx;
  try {
    await muteOnce(ctx);
    const taskCsv = await f.getRepoFile(owner, repo, TASK_PATH);
    const task = findRow(parseTaskCsv(taskCsv ?? ""), task_id, "");
    if (!task) return { error: `Unknown task ${task_id}.` };
    const fragment = task.fragment;
    // A recognition record from an earlier session of the claim was saved
    // with the work; the campaign's own record still proposes the score
    // definition when neither is given.
    const recordPath = omrRecordPath(fragment);
    const campaignRecord = instruments
      ? await f.getRepoFile(owner, repo, recordPath)
      : null;
    const record =
      omr ?? (instruments ? await savedSideFile(ctx, task, recordPath) : null);
    const recordChanged = record != null && record !== campaignRecord;
    const { content, corrected } = await facsimileScore(
      ctx,
      task,
      pages,
      layout,
      instruments,
      record ?? campaignRecord,
    );
    // The layout model's raw output from an earlier session of the claim
    // was saved with the work.
    const rawLayoutJson = rawLayout
      ? JSON.stringify(rawLayout, null, "\t") + "\n"
      : layout
        ? await savedSideFile(ctx, task, layoutRecordPath(fragment))
        : null;
    const correctedChanged =
      corrected !== null &&
      corrected !==
        (await f.getRepoFile(owner, repo, correctedLayoutPath(fragment)));
    const meiError = await checkMei(content);
    if (meiError)
      return {
        error: `The score fails the MEI schema check (${meiError}). Nothing was submitted.`,
      };
    const title = layout
      ? `Correct the layout (${task_id})`
      : `Correct measure zones (${task_id})`;
    const body = `${title}. Opened from the app.`;
    const label = `${layout ? "Layout" : "Measure"} correction of ${task_id}`;
    // The corrected boxes, the layout model's raw output and the recognition
    // record go next to the score, one file each per piece. The score is
    // committed when unchanged too, which gives the pull request a commit
    // when nothing differs from the campaign's (boxes confirmed as they
    // are).
    const files: FileChange[] = [{ path: fragment, content }];
    if (correctedChanged) {
      files.push({ path: correctedLayoutPath(fragment), content: corrected! });
    }
    if (rawLayoutJson) {
      files.push({ path: layoutRecordPath(fragment), content: rawLayoutJson });
    }
    if (recordChanged) files.push({ path: recordPath, content: record! });
    return openAndFinishInBackground(
      ctx,
      label,
      { kind: "encode", task: task_id },
      async () => {
        console.log("[zones] opening PR", { task_id });
        const pr = await openPreTaskSubmission(
          ctx,
          layout ? "layout" : "zones",
          task_id,
          files,
          (branch) =>
            f.openChangePr(owner, repo, {
              branch,
              files,
              message: title,
              title,
              body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
            }),
        );
        console.log("[zones] PR opened", pr.number, pr.html_url);
        return { ...pr, cleanup: "accepted", taskBranch: task_id };
      },
    );
  } catch (e) {
    return { error: `Submission failed: ${(e as Error).message}` };
  }
}

// The viewer's pre-task submission on `task_id` still open, from another tab
// or device (head branch `<prefix>-<task_id>-…`), which a repeat submission
// follows instead of opening a second pull request that would be rejected,
// when its head holds `files` as they are; else the one `open` opens on a new
// branch. Throws when the open submission holds other content.
async function openPreTaskSubmission(
  ctx: CommandContext,
  prefix: string,
  task_id: string,
  files: FileChange[],
  open: (branch: string) => Promise<OpenedChangeRequest>,
): Promise<OpenedChangeRequest> {
  const { forge: f, owner, repo, viewer } = ctx;
  const branchPrefix = `${prefix}-${task_id}-`;
  const pending = await f.findOpenChangeRequest(
    owner,
    repo,
    viewer,
    branchPrefix,
  );
  if (!pending) return open(`${branchPrefix}${shortId()}`);
  const { head } = pending;
  const held = await Promise.all(
    files.map((file) =>
      f.getRepoFile(head.owner, head.repo, file.path, head.branch),
    ),
  );
  if (files.some((file, i) => held[i] !== file.content))
    throw new Error(
      `submission #${pending.number} of ${task_id} is still open with other content and must be decided first.`,
    );
  return pending;
}

// Measure correction: submit stage C — the corrected zones with one generated
// measure per zone (numbered from the zone labels), the page/system breaks,
// and one <mdiv> per marked movement. The validation subtask reviews all of it.
const submitZones: CommandDef<{ task_id: string; pages: PageModel[] }, Result> =
  {
    id: "campaign.submitZones",
    version: 2,
    log: "pr",
    background: true,
    envelopeInput: ({ task_id, pages }) => ({
      task_id,
      measures: pages.reduce((n, p) => n + p.zones.length, 0),
      systems: pages.reduce(
        (n, p) => n + p.zones.filter((z) => z.sb).length,
        0,
      ),
      movements:
        1 + pages.reduce((n, p) => n + p.zones.filter((z) => z.mdiv).length, 0),
    }),
    run: ({ task_id, pages }, ctx, envelope) =>
      submitFacsimile(ctx, task_id, pages, envelope),
  };

// Layout correction: submit the corrected staff, grand-staff and measure
// boxes of an OMR-prepared piece at stage C with empty measures — the breaks
// and movements as for measure correction, the boxes in
// `layout-corrected.json` alongside. The validation subtask reviews the
// boxes. `layout` is the model's raw output for every page, present when
// detection ran in the editor session; it is committed as `layout.json` next
// to the score. `instruments` are the instruments the layout task named, for
// a piece prepared as 'omr-instruments'; `omr` is that piece's recognition
// record, committed as `omr.xml` next to the score for the page drafts.
const submitOmrLayout: CommandDef<
  {
    task_id: string;
    pages: PageModel[];
    layout?: LayoutRecord;
    instruments?: LayoutInstruments;
    omr?: string;
  },
  Result
> = {
  id: "campaign.submitOmrLayout",
  version: 2,
  log: "pr",
  background: true,
  envelopeInput: ({ task_id, pages }) => ({
    task_id,
    staves: pages.reduce((n, p) => n + (p.staves?.length ?? 0), 0),
    grandstaves: pages.reduce((n, p) => n + (p.grandstaves?.length ?? 0), 0),
    measures: pages.reduce((n, p) => n + p.zones.length, 0),
    systems: pages.reduce((n, p) => n + p.zones.filter((z) => z.sb).length, 0),
    movements:
      1 + pages.reduce((n, p) => n + p.zones.filter((z) => z.mdiv).length, 0),
  }),
  run: ({ task_id, pages, layout, instruments, omr }, ctx, envelope) =>
    submitFacsimile(
      ctx,
      task_id,
      pages,
      envelope,
      true,
      layout,
      instruments,
      omr,
    ),
};

// The score a score setup's definition amounts to, built on the campaign's
// current score as described at submitScoreSetup.
async function setupScore(
  ctx: CommandContext,
  task: TaskRow,
  scoreDef: ScoreDefModel,
): Promise<{ content: string }> {
  const { forge: f, owner, repo } = ctx;
  const fragment = task.fragment;
  const [current, configYaml] = await Promise.all([
    f.getRepoFile(owner, repo, fragment),
    f.getRepoFile(owner, repo, CONFIG_PATH),
  ]);
  if (current == null) throw new Error(`Could not read ${fragment}.`);
  const parsed = parseFacsimileMei(current);
  const omr = usesOmr(pieceFieldForPath(configYaml, fragment, "preparation"));
  // A score holding notation (transcriptions, or an aligned encoding) keeps
  // its measures: only its definition is replaced.
  const content = hasNotation(current)
    ? replaceScoreDef(current, scoreDef)
    : omr
      ? buildFacsimileMei(
          {
            headXml: parsed.headXml,
            scoreDef,
            pages: withCorrectedLayout(
              parsed.pages,
              await f.getRepoFile(owner, repo, correctedLayoutPath(fragment)),
            ),
          },
          {
            withBreaks: parsed.hasBreaks,
            emptyMeasures: true,
            padZones: true,
          },
        )
      : pieceKindForPath(configYaml, fragment) === "physical-only"
        ? buildBlankScoreMei(
            parsed.headXml,
            (current.match(/<pb\b/g) ?? []).length,
            scoreDef,
          )
        : buildFacsimileMei(
            { headXml: parsed.headXml, scoreDef, pages: parsed.pages },
            { withBreaks: parsed.hasBreaks },
          );
  return { content };
}

// Score setup: submit the piece's initial score definition — staves with their
// clefs and instrument labels, key signature and meter — by rebuilding the
// score around it. A facsimile piece is rebuilt at the stage it is already at,
// with its header, pages and breaks carried over; a physical piece's blank
// score is rebuilt with its page count read from the file's <pb> markers. An
// OMR-prepared piece is rebuilt with empty measures while it holds no
// notation, so its staff count can still change; once transcriptions are in
// its measures only its <scoreDef> is replaced, since a rebuild would discard
// them. `omr` is an OMR-prepared piece's recognition record, committed as
// `omr.xml` next to the score for the page drafts. The validation subtask
// reviews the entered values.
const submitScoreSetup: CommandDef<
  { task_id: string; scoreDef: ScoreDefModel; omr?: string },
  Result
> = {
  id: "campaign.submitScoreSetup",
  version: 1,
  log: "pr",
  background: true,
  envelopeInput: ({ task_id, scoreDef }) => ({
    task_id,
    staves: scoreDef.staves.length,
    groups: scoreDef.groups.length,
    keysig: scoreDef.keysig,
    meter: scoreDef.meterSym || `${scoreDef.meterCount}/${scoreDef.meterUnit}`,
  }),
  async run({ task_id, scoreDef, omr: given }, ctx, envelope) {
    const { forge: f, owner, repo } = ctx;
    try {
      await muteOnce(ctx);
      const taskCsv = await f.getRepoFile(owner, repo, TASK_PATH);
      const task = findRow(parseTaskCsv(taskCsv ?? ""), task_id, "");
      if (!task) return { error: `Unknown task ${task_id}.` };
      const fragment = task.fragment;
      const { content } = await setupScore(ctx, task, scoreDef);
      const recordPath = omrRecordPath(fragment);
      // A recognition record from an earlier session of the claim was saved
      // with the work.
      const record = given ?? (await savedSideFile(ctx, task, recordPath));
      const recordChanged =
        record != null &&
        record !== (await f.getRepoFile(owner, repo, recordPath));
      const meiError = await checkMei(content);
      if (meiError)
        return {
          error: `The score fails the MEI schema check (${meiError}). Nothing was submitted.`,
        };
      const title = `Set up the score (${task_id})`;
      const body = `${title}. Opened from the score setup editor.`;
      // The score is committed when unchanged too, which gives the pull
      // request a commit when the definition is confirmed as it is.
      const files: FileChange[] = [
        { path: fragment, content },
        ...(recordChanged ? [{ path: recordPath, content: record! }] : []),
      ];
      return openAndFinishInBackground(
        ctx,
        `Score setup of ${task_id}`,
        { kind: "encode", task: task_id },
        async () => {
          console.log("[setup] opening PR", { task_id });
          const pr = await openPreTaskSubmission(
            ctx,
            "setup",
            task_id,
            files,
            (branch) =>
              f.openChangePr(owner, repo, {
                branch,
                files,
                message: title,
                title,
                body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
              }),
          );
          console.log("[setup] PR opened", pr.number, pr.html_url);
          return { ...pr, cleanup: "accepted", taskBranch: task_id };
        },
      );
    } catch (e) {
      return { error: `Submission failed: ${(e as Error).message}` };
    }
  },
};

// The score and alignment record an encoding alignment with `pins` and the
// other choices amounts to, made on the campaign's score as described at
// alignEncoding.
async function alignmentScore(
  ctx: CommandContext,
  task: TaskRow,
  pins: Pin[],
  { scoreStaves, fileEdits }: AlignmentChoices,
) {
  const { forge: f, owner, repo } = ctx;
  const configYaml = await f.getRepoFile(owner, repo, CONFIG_PATH);
  const [upload, , campaign] = await alignmentInputs(ctx, task, configYaml, {
    owner,
    repo,
    ref: undefined,
  });
  const aligned = alignEncoding({
    current: campaign.mei,
    corrected: campaign.corrected,
    upload,
    preparation:
      pieceFieldForPath(configYaml, task.fragment, "preparation") ??
      "measure-detection",
    pins,
    scoreStaves,
    fileEdits,
  });
  return aligned;
}

// Encoding alignment: submit the uploaded encoding merged into the piece's
// measures along the alignment the pins give, with the alignment record. A
// file that does not fit the piece (kind "different") is not submitted.
const submitEncodingAlignment: CommandDef<
  { task_id: string; pins: Pin[] } & AlignmentChoices,
  Result
> = {
  id: "campaign.submitEncodingAlignment",
  version: 1,
  log: "pr",
  background: true,
  envelopeInput: ({ task_id, pins }) => ({ task_id, pins: pins.length }),
  async run({ task_id, pins, ...choices }, ctx, envelope) {
    const { forge: f, owner, repo } = ctx;
    try {
      await muteOnce(ctx);
      const taskCsv = await f.getRepoFile(owner, repo, TASK_PATH);
      const task = findRow(parseTaskCsv(taskCsv ?? ""), task_id, "");
      if (!task) return { error: `Unknown task ${task_id}.` };
      const aligned = await alignmentScore(ctx, task, pins, choices);
      if (aligned.summary.kind === "different")
        return { error: differentReason(aligned.summary) };
      const content = aligned.merged.mei;
      const recordPath = alignmentPath(task.fragment);
      const recordChanged =
        aligned.record !== (await f.getRepoFile(owner, repo, recordPath));
      const meiError = await checkMei(content);
      if (meiError)
        return {
          error: `The score fails the MEI schema check (${meiError}). Nothing was submitted.`,
        };
      const title = alignmentMessage(task_id, aligned.layout, aligned.merged);
      const body = `${title}. Opened from the encoding alignment editor.`;
      // The score is committed when unchanged too, which gives the pull
      // request a commit when the alignment is confirmed as it is.
      const files: FileChange[] = [
        { path: task.fragment, content },
        ...(recordChanged
          ? [{ path: recordPath, content: aligned.record }]
          : []),
      ];
      return openAndFinishInBackground(
        ctx,
        `Encoding alignment of ${task_id}`,
        { kind: "encode", task: task_id },
        async () => {
          console.log("[align] opening PR", { task_id });
          const pr = await openPreTaskSubmission(
            ctx,
            "align",
            task_id,
            files,
            (branch) =>
              f.openChangePr(owner, repo, {
                branch,
                files,
                message: title,
                title,
                body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
              }),
          );
          console.log("[align] PR opened", pr.number, pr.html_url);
          return { ...pr, cleanup: "accepted", taskBranch: task_id };
        },
      );
    } catch (e) {
      return { error: `Submission failed: ${(e as Error).message}` };
    }
  },
};

export {
  alignmentScore,
  facsimileScore,
  readFacsimile,
  setupScore,
  submitEncodingAlignment,
  submitOmrLayout,
  submitScoreSetup,
  submitZones,
};
