// The draft an OMR-prepared piece's encoding task starts from: one page for
// a page task, every page in turn for a whole-file task. Run when the
// encoding task's branch has just been created: the page's staff
// transcriptions and labels are taken from the piece's recognition record
// (`omr.xml`, committed by the score setup or the layout task), with its clef
// corrections, stitched into a page score (each staff on the score staff
// its named instrument gives, where the layout task names the instruments,
// else on the one suggested for it from its clef, its instrument label and
// the staff spacing, since a system may print fewer staves than the score
// has) that starts in the clefs, key and meter the pages before it leave in
// force, converted to MEI by verovio and put into the page's measures of the
// piece's score, which is then committed to the task branch mei-friend
// opens. With named instruments, the staves follow the staff plan
// (staffPlan): a staff a system does not print rests where its instrument's
// parts rest and holds an mSpace where they are on other staves
// (unprintedStaves), a printed staff's layers are numbered by its parts, a
// system opens with a `<scoreDef>` where the staves it shows or their names
// change (systemScoreDef), and the note names the page's reasons to check it
// (pageChecks). The first page
// task's check of the opening score definition is put into the score before
// the draft, so the draft starts from it and commits it. No recognition runs
// here.
// Browser only: the verovio WASM module.

import type { ForgeClient } from "./forge/types.ts";
import {
  parseFacsimileMei,
  replaceOpeningScoreDef,
  type ScoreDefModel,
} from "./mei-facsimile.ts";
import { stitchPage } from "./omr-stitch.ts";
import {
  pageStart,
  pieceStaves,
  placementsOf,
  scoreStaves,
} from "./omr-timeline.ts";
import { insertPageDraft } from "./omr-draft.ts";
import { omrRecordPath, parseOmrRecord, type OmrRecord } from "./omr-record.ts";
import {
  correctedLayoutPath,
  layoutInstruments,
  layoutSource,
  withCorrectedLayout,
  type LayoutSource,
} from "./omr-layout.ts";
import {
  plannedSystemIndex,
  staffPlan,
  staffStates,
  systemScoreDef,
  unprintedStaves,
} from "./instrument-naming.ts";
import { namedPieceStaves, pageChecks } from "./omr-page-checks.ts";
import { tidyMei } from "./mei-format.ts";
import { recordApplications, type Application } from "./mei-provenance.ts";
import { addXmlIds } from "./mei-ids.ts";
import { checkMei } from "./mei-check.ts";
import { createToolkit } from "./verovio-render.ts";
import type { VerovioToolkit } from "verovio/esm";

// The transcription is converted in a toolkit of its own, leaving the shared
// one to the score preview whose document it holds.
let converter: Promise<VerovioToolkit> | null = null;
const getConverter = (): Promise<VerovioToolkit> =>
  (converter ??= createToolkit().catch((err) => {
    converter = null;
    throw err;
  }));

export interface PageDraftOptions {
  forge: ForgeClient;
  /** The campaign repo and the head the branch was created at. */
  owner: string;
  repo: string;
  headSha: string;
  /** Where the task branch lives (the campaign repo or the volunteer's fork). */
  workRepo: { owner: string; repo: string };
  branch: string;
  /** The piece's score path and the page (1-based) the task covers. */
  fragment: string;
  page: number;
  /**
   * The opening score definition as the first page task's check gave it:
   * put into the score before the draft, which is made and committed with
   * it; absent keeps the score's.
   */
  scoreDef?: ScoreDefModel;
  progress: (step: string) => void;
}

export interface PageDraftResult {
  /** What was done, for the hand-off message; names every mismatch. */
  note: string;
  /** The mismatches the note names: staves left out, empty or misplaced. */
  warnings: string[];
}

/**
 * The applications the header records for a transcription: the layout model
 * with the day it ran, where the corrected layout names it, and the staff
 * pipeline with the model it ran and the day it ran.
 */
export function transcriptionApplications(
  layout: LayoutSource | null,
  record: OmrRecord,
): Application[] {
  const { staffPipeline: pipeline, staffModel: model } = record;
  return [
    ...(layout
      ? [
          {
            name: `Musibot ${layout.model.name} ${layout.model.version}`,
            isodate: layout.detected,
            description: `Layout detection by the model ${layout.model.name} ${layout.model.version}.`,
          },
        ]
      : []),
    {
      name: `Musibot ${pipeline.name} ${pipeline.version}`,
      isodate: record.transcribed,
      description: model
        ? `Staff transcription by the pipeline ${pipeline.name} ${pipeline.version} with the model ${model.name} ${model.version}.`
        : "",
    },
  ];
}

/** The draft of one page task: that page of the piece. */
export const draftPage = (o: PageDraftOptions): Promise<PageDraftResult> =>
  draftPages(o, o.page);

/** The draft of a whole-file task: every page of the piece, in one commit. */
export const draftPiece = (
  o: Omit<PageDraftOptions, "page">,
): Promise<PageDraftResult> => draftPages(o, null);

// The draft of page `only`, or of every page of the piece (null): each page
// is put into the score the pages before it left, and the result is checked
// and committed once.
async function draftPages(
  o: Omit<PageDraftOptions, "page">,
  only: number | null,
): Promise<PageDraftResult> {
  const { forge, owner, repo, fragment } = o;
  const [scoreAtHead, recordXml, corrected] = await Promise.all([
    forge.getRepoFile(owner, repo, fragment, o.headSha),
    forge.getRepoFile(owner, repo, omrRecordPath(fragment), o.headSha),
    forge.getRepoFile(owner, repo, correctedLayoutPath(fragment), o.headSha),
  ]);
  if (scoreAtHead == null) throw new Error(`Could not read ${fragment}.`);
  let score = o.scoreDef
    ? replaceOpeningScoreDef(scoreAtHead, o.scoreDef)
    : scoreAtHead;
  const parsed = parseFacsimileMei(score);
  parsed.pages = withCorrectedLayout(parsed.pages, corrected);
  if (only !== null && !parsed.pages[only - 1])
    throw new Error(`${fragment} has no page ${only}.`);
  const pageNumbers = only ? [only] : parsed.pages.map((_, i) => i + 1);
  const subject = only ? `page ${only}` : "the piece";
  const record = parseOmrRecord(recordXml);
  if (!record) {
    return {
      note: `The piece has no recognition record (${omrRecordPath(fragment)}), so ${subject} has no draft.`,
      warnings: [],
    };
  }
  o.progress("Reading the recognition record");
  // Recorded before the pages are drafted, so the header entries get their
  // ids with the first drafted page's.
  score = recordApplications(
    score,
    transcriptionApplications(layoutSource(corrected), record),
  );
  // The piece read through: clef corrections, and the clefs, key and meter
  // in force where each page starts.
  const named = corrected ? layoutInstruments(corrected) : null;
  const plan = named ? staffPlan(named, parsed.pages) : null;
  const pieces = plan
    ? namedPieceStaves(parsed, record, plan)
    : pieceStaves(parsed, record, scoreStaves(parsed));
  const allUnprinted = plan ? unprintedStaves(plan) : [];
  const states = plan ? staffStates(plan) : [];
  const allChecks = plan ? pageChecks(parsed, pieces, plan) : [];

  // Pages without a draft and why, the mismatches of the drafted ones, and
  // the reasons to check them; in a piece's draft each names its page.
  const skipped: string[] = [];
  const warnings: string[] = [];
  const checks: string[] = [];
  const of = (page: number, text: string) =>
    only ? text : `Page ${page}: ${text}`;
  let drafted = 0;
  let filled = 0;
  for (const page of pageNumbers) {
    if (!parsed.pages[page - 1].staves?.length) {
      skipped.push(`Page ${page} has no staff boxes, so it has no draft.`);
      continue;
    }
    const staves = pieces[page - 1];
    const flat = staves.systems.flat();
    if (!flat.length) {
      skipped.push(
        `Page ${page}: no staff box lies on a system of measure boxes, so it has no draft.`,
      );
      continue;
    }
    const unrecorded = staves.entries.flat().filter((e) => !e).length;
    const failed = staves.entries.flat().filter((e) => e && !e.musicxml).length;

    o.progress(
      only
        ? "Assembling the page"
        : `Assembling page ${page} of ${pageNumbers.length}`,
    );
    const printed = staves.systems.map(
      (_, s) => new Set(staves.assigned[s].filter((n) => n > 0)),
    );
    const left = staves.assigned.flat().filter((n) => n === 0).length;
    // Per system of the page, from the staff plan solved through the piece:
    // how the staves it does not print are written, the parts each printed
    // staff carries, and the <scoreDef> it opens with.
    const planned = staves.systems.map((_, s) =>
      plan ? plannedSystemIndex(plan, page - 1, s) : -1,
    );
    const unprinted = planned.map((g) => allUnprinted[g] ?? new Map());
    const layerParts = planned.map(
      (g) =>
        new Map(
          g < 0 || !plan
            ? []
            : [...plan.systems[g].boxes.values()].flatMap((at) =>
                plan.staves[at.n - 1].instrument.parts.length
                  ? [[at.n, at.parts] as const]
                  : [],
              ),
        ),
    );
    const systemScoreDefs = planned.map((g) =>
      plan && g >= 0 ? systemScoreDef(plan, states, g) : "",
    );
    const start = pageStart(parsed, pieces, page);
    const stitched = stitchPage(
      staves.transcriptions,
      start.clefs,
      placementsOf(staves),
      start,
    );
    const tk = await getConverter();
    let draft: ReturnType<typeof insertPageDraft>;
    try {
      if (!tk.loadData(stitched.musicxml))
        throw new Error("Verovio could not read the transcription.");
      draft = insertPageDraft(
        score,
        `surface-${page}`,
        tk.getMEI({}),
        stitched.measuresPerSystem,
        printed,
        stitched.opening,
        unprinted,
        layerParts,
        systemScoreDefs,
      );
    } catch (e) {
      // A page task has nothing else to open with. In a piece's draft the
      // page stays empty and the other pages are drafted.
      if (only) throw e;
      warnings.push(
        `Page ${page} could not be drafted and stays empty: ${(e as Error).message}`,
      );
      continue;
    }
    // Drafts of other pages start from the same score; the page prefix keeps
    // their new ids apart when they are spliced in or follow one another.
    score = addXmlIds(draft.mei, `p${page}-`);
    drafted++;
    filled += draft.filled;
    warnings.push(
      ...[
        ...(staves.unplaced
          ? [
              `${staves.unplaced} staff box(es) lie on no system of measure boxes and were left out.`,
            ]
          : []),
        ...(failed
          ? [
              `${failed} of ${flat.length} staves could not be transcribed and stay empty.`,
            ]
          : []),
        ...(unrecorded
          ? [
              `${unrecorded} of ${flat.length} staves are not in the recognition record, since their boxes changed after the score setup, and stay empty.`,
            ]
          : []),
        ...(left
          ? [
              named
                ? `${left} staff box(es) name no staff of the score and were left out.`
                : `${left} staff box(es) are more than the score has staves and were left out.`,
            ]
          : []),
        ...draft.warnings,
      ].map((w) => of(page, w)),
    );
    checks.push(...(allChecks[page - 1] ?? []).map((c) => of(page, c)));
  }
  if (!drafted)
    return {
      note:
        [...skipped, ...warnings].join(" ") ||
        "The piece has no pages, so it has no draft.",
      warnings,
    };

  const content = tidyMei(score);
  const meiError = await checkMei(content);
  if (meiError)
    throw new Error(`The draft fails the MEI schema check (${meiError}).`);

  o.progress("Committing the draft to the task branch");
  await forge.commitFiles(
    o.workRepo.owner,
    o.workRepo.repo,
    [{ path: fragment, content }],
    `Transcription draft of ${only ? `page ${only}` : `${drafted} page(s)`} (${record.staffPipeline.name} ${record.staffPipeline.version})`,
    { branch: o.branch },
  );

  return {
    note:
      (only
        ? `Page ${only} was drafted into ${filled} measure(s).`
        : `${drafted} page(s) were drafted into ${filled} measure(s).`) +
      (skipped.length ? ` ${skipped.join(" ")}` : "") +
      (warnings.length ? ` ${warnings.join(" ")}` : "") +
      (checks.length
        ? ` Check the clefs, key, meter and staves against the scan: ${checks.join(" ")}`
        : ""),
    warnings,
  };
}
