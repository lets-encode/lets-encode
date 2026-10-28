// The draft an OMR-prepared piece's page task starts from. Run when the
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
import type { OmrPipeline } from "./omr-client.ts";
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
import { omrRecordPath, parseOmrRecord } from "./omr-record.ts";
import {
  correctedLayoutPath,
  layoutInstruments,
  withCorrectedLayout,
} from "./omr-layout.ts";
import {
  plannedSystemIndex,
  staffPlan,
  staffStates,
  systemScoreDef,
  unprintedStaves,
} from "./instrument-naming.ts";
import { namedPieceStaves, pageChecks } from "./omr-page-checks.ts";
import { recordApplications } from "./mei-provenance.ts";
import { addXmlIds } from "./mei-ids.ts";
import { checkMei } from "./mei-check.ts";
import { getVerovio } from "./verovio-render.ts";

/** The Musibot models the OMR preparation runs, pinned by version. */
export interface OmrModels {
  layoutModel: OmrPipeline;
  staffPipeline: OmrPipeline;
}

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
  models: OmrModels;
  progress: (step: string) => void;
}

export interface PageDraftResult {
  /** What was done, for the hand-off message; names every mismatch. */
  note: string;
  /** The mismatches the note names: staves left out, empty or misplaced. */
  warnings: string[];
}

/** The application names the header records for a transcription. */
export const applicationNames = (models: OmrModels): string[] =>
  [models.layoutModel, models.staffPipeline].map(
    (m) => `Musibot ${m.name} ${m.version}`,
  );

export async function draftPage(o: PageDraftOptions): Promise<PageDraftResult> {
  const { forge, owner, repo, fragment, page } = o;
  const [scoreAtHead, recordXml, corrected] = await Promise.all([
    forge.getRepoFile(owner, repo, fragment, o.headSha),
    forge.getRepoFile(owner, repo, omrRecordPath(fragment), o.headSha),
    forge.getRepoFile(owner, repo, correctedLayoutPath(fragment), o.headSha),
  ]);
  if (scoreAtHead == null) throw new Error(`Could not read ${fragment}.`);
  const score = o.scoreDef
    ? replaceOpeningScoreDef(scoreAtHead, o.scoreDef)
    : scoreAtHead;
  const parsed = parseFacsimileMei(score);
  parsed.pages = withCorrectedLayout(parsed.pages, corrected);
  const pg = parsed.pages[page - 1];
  if (!pg) throw new Error(`${fragment} has no page ${page}.`);
  if (!pg.staves?.length) {
    return {
      note: `Page ${page} has no staff boxes, so it has no draft.`,
      warnings: [],
    };
  }
  const record = parseOmrRecord(recordXml);
  if (!record) {
    return {
      note: `The piece has no recognition record (${omrRecordPath(fragment)}), so page ${page} has no draft.`,
      warnings: [],
    };
  }
  o.progress("Reading the recognition record");
  // The piece read through to this page: clef corrections, and the clefs,
  // key and meter in force where the page starts.
  const named = corrected ? layoutInstruments(corrected) : null;
  const plan = named ? staffPlan(named, parsed.pages) : null;
  const pieces = plan
    ? namedPieceStaves(parsed, record, plan)
    : pieceStaves(parsed, record, scoreStaves(parsed));
  const staves = pieces[page - 1];
  const flat = staves.systems.flat();
  if (!flat.length) {
    return {
      note: `Page ${page}: no staff box lies on a system of measure boxes, so it has no draft.`,
      warnings: [],
    };
  }
  const unrecorded = staves.entries.flat().filter((e) => !e).length;
  const failed = staves.entries.flat().filter((e) => e && !e.musicxml).length;

  o.progress("Assembling the page");
  const printed = staves.systems.map(
    (_, s) => new Set(staves.assigned[s].filter((n) => n > 0)),
  );
  const left = staves.assigned.flat().filter((n) => n === 0).length;
  // Per system of the page, from the staff plan solved through the piece:
  // how the staves it does not print are written, the parts each printed
  // staff carries, and the <scoreDef> it opens with; and why the page is to
  // be checked.
  const planned = staves.systems.map((_, s) =>
    plan ? plannedSystemIndex(plan, page - 1, s) : -1,
  );
  const allUnprinted = plan ? unprintedStaves(plan) : [];
  const states = plan ? staffStates(plan) : [];
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
  const checks = plan ? pageChecks(parsed, pieces, plan)[page - 1] : [];
  const start = pageStart(parsed, pieces, page);
  const stitched = stitchPage(
    staves.transcriptions,
    start.clefs,
    placementsOf(staves),
    start,
  );
  const tk = await getVerovio();
  if (!tk.loadData(stitched.musicxml))
    throw new Error("Verovio could not read the transcription.");
  const draft = insertPageDraft(
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
  const models = {
    layoutModel: o.models.layoutModel,
    staffPipeline: record.staffPipeline,
  };
  const content = addXmlIds(
    recordApplications(draft.mei, applicationNames(models)),
  );
  const meiError = await checkMei(content);
  if (meiError)
    throw new Error(`The draft fails the MEI schema check (${meiError}).`);

  o.progress("Committing the draft to the task branch");
  await forge.commitFiles(
    o.workRepo.owner,
    o.workRepo.repo,
    [{ path: fragment, content }],
    `Transcription draft of page ${page} (${record.staffPipeline.name} ${record.staffPipeline.version})`,
    { branch: o.branch },
  );

  const warnings = [
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
  ];
  return {
    note:
      `Page ${page} was drafted into ${draft.filled} measure(s).` +
      (warnings.length ? ` ${warnings.join(" ")}` : "") +
      (checks.length
        ? ` Check the clefs, key, meter and staves against the scan: ${checks.join(" ")}`
        : ""),
    warnings,
  };
}
