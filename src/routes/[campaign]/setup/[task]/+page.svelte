<script module lang="ts">
  // The source side's share of the work area's width in each step, kept
  // across tasks for the session, as the wizard keeps its panes' sizes. Step
  // 2 gives the preview, where the groups are marked, most of the width.
  const split = $state<Record<1 | 2, number>>({ 1: 0.5, 2: 0.3 });
</script>

<script lang="ts">
  import { commentAnchor } from "$lib/campaign-tables.ts";
  import Icon from "$lib/components/Icon.svelte";
  import StepGlyph from "$lib/components/StepGlyph.svelte";
  import GlyphSelect from "$lib/components/GlyphSelect.svelte";
  import MusicGlyph, {
    type MusicGlyphName,
  } from "$lib/components/MusicGlyph.svelte";
  import { page } from "$app/state";
  import { tick, untrack, type Snippet } from "svelte";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type {
    CommandContext,
    Result,
    FacsimileTaskData,
  } from "$lib/commands.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import {
    DOCKED_QUERY,
    PANEL_MIN_REVIEW,
    readSidePanel,
  } from "$lib/side-panels.ts";
  import { MediaQuery, SvelteSet } from "svelte/reactivity";
  import {
    buildBlankScoreMei,
    DEFAULT_SCORE_DEF,
    staffKeysig,
  } from "$lib/mei-facsimile.ts";
  import {
    COMMON_TRANSPOSITIONS,
    PITCHES,
    fromCustom,
    keysigText,
    soundsText,
    toCustom,
    transpositionFromLabel,
    writtenKeysig,
  } from "$lib/transposition.ts";
  import type { Transposition } from "$lib/transposition.ts";
  import type {
    MeasureBox,
    ScoreDefModel,
    StaffModel,
    StaffGroupModel,
  } from "$lib/mei-facsimile.ts";
  import {
    groupDepth,
    groupsValid as groupsFit,
    guessOneInstrument,
    moveStaffInGroups,
    removeStaffFromGroups,
    sortGroups,
    spanProblem,
  } from "$lib/staff-groups.ts";
  import { createOmrClient } from "$lib/omr-client.ts";
  import {
    grandStaffSpans,
    pageSystems,
    staffCountOf,
  } from "$lib/omr-layout.ts";
  import {
    clefStaff,
    clefToken,
    proposeScoreDef,
    staffClefToken,
  } from "$lib/omr-musicxml.ts";
  import { openingClefs, pieceStaves } from "$lib/omr-timeline.ts";
  import { suggestStaffAssignment } from "$lib/omr-staff-assign.ts";
  import {
    omrRecordPath,
    parseOmrRecord,
    serializeOmrRecord,
  } from "$lib/omr-record.ts";
  import type { OmrRecord } from "$lib/omr-record.ts";
  import { recognisePiece } from "$lib/omr-piece-recognition.ts";
  import type { PieceRecognition } from "$lib/omr-piece-recognition.ts";
  import { provider, omr as omrModels } from "$lib/forge/config.ts";
  import { getVerovio, loadSnippet, renderPage } from "$lib/verovio-render.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import FacsimileFrame, {
    fitRoom,
  } from "$lib/components/FacsimileFrame.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import ReviewActions from "$lib/components/ReviewActions.svelte";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import DraftBubble from "$lib/components/DraftBubble.svelte";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // The clefs and staff kinds the form offers, by name. Each option carries
  // the staff values it sets: clef shape, line, octave displacement and
  // notation type as MEI writes them, and the staff's line count. A modern
  // (guitar) tablature staff shows the TAB lettering as its clef; the lute
  // kinds carry no clef.
  const pitchedClef = (
    value: string,
    label: string,
    clefShape: string,
    clefLine: number,
    clefDis = "",
  ) => ({
    value,
    label,
    glyph: (clefDis
      ? "gClef8vb"
      : clefShape === "G"
        ? "gClef"
        : clefShape === "F"
          ? "fClef"
          : "cClef") as MusicGlyphName,
    clefShape,
    clefDis,
    notationType: "",
    clefLine,
    lines: 5,
  });
  const CLEF_OPTIONS = [
    pitchedClef("G2", "Treble", "G", 2),
    pitchedClef("G2-8", "Treble, octave lower", "G", 2, "8"),
    pitchedClef("G1", "French violin", "G", 1),
    pitchedClef("C1", "Soprano", "C", 1),
    pitchedClef("C2", "Mezzo-soprano", "C", 2),
    pitchedClef("C3", "Alto", "C", 3),
    pitchedClef("C4", "Tenor", "C", 4),
    pitchedClef("C5", "Baritone (C clef)", "C", 5),
    pitchedClef("F3", "Baritone (F clef)", "F", 3),
    pitchedClef("F4", "Bass", "F", 4),
    pitchedClef("F5", "Sub-bass", "F", 5),
    {
      value: "perc",
      label: "Percussion",
      glyph: "percussion" as MusicGlyphName,
      clefShape: "perc",
      clefDis: "",
      notationType: "",
      clefLine: 3,
      lines: 5,
    },
    {
      value: "TAB",
      label: "Tablature, modern",
      glyph: "tab" as MusicGlyphName,
      clefShape: "TAB",
      clefDis: "",
      notationType: "tab.guitar",
      clefLine: 3,
      lines: 6,
    },
    {
      value: "TABfr",
      label: "Tablature, French",
      clefShape: "TAB",
      clefDis: "",
      notationType: "tab.lute.french",
      clefLine: 3,
      lines: 6,
    },
    {
      value: "TABit",
      label: "Tablature, Italian",
      clefShape: "TAB",
      clefDis: "",
      notationType: "tab.lute.italian",
      clefLine: 3,
      lines: 6,
    },
    {
      value: "TABde",
      label: "Tablature, German",
      clefShape: "TAB",
      clefDis: "",
      notationType: "tab.lute.german",
      clefLine: 3,
      lines: 6,
    },
  ] as const;
  // The clefs most staves open with, listed first in the clef menu.
  const COMMON_CLEFS = ["G2", "F4", "C3"];
  // The option behind a staff's stored values: the one with its shape,
  // displacement and notation type, and for a pitched clef its line too.
  // An unlisted combination (an OMR reading, an imported file) has none.
  const clefOption = (staff: StaffModel) =>
    CLEF_OPTIONS.find(
      (o) =>
        o.clefShape === staff.clefShape &&
        o.clefDis === staff.clefDis &&
        o.notationType === staff.notationType &&
        (unpitched(staff) || o.clefLine === staff.clefLine),
    );
  const unpitched = (staff: StaffModel): boolean =>
    staff.clefShape === "perc" || staff.clefShape === "TAB";
  /** The symbol of a staff's clef: its option's, else its shape's. */
  function clefGlyph(staff: StaffModel): MusicGlyphName | undefined {
    const option = clefOption(staff);
    if (option) return "glyph" in option ? option.glyph : undefined;
    return (
      { G: "gClef", F: "fClef", C: "cClef" } as Record<string, MusicGlyphName>
    )[staff.clefShape];
  }
  /** A staff's clef as text. */
  function clefText(staff: StaffModel): string {
    const option = clefOption(staff);
    if (option) return option.label;
    const octaves =
      { "8": "an octave", "15": "two octaves", "22": "three octaves" }[
        staff.clefDis
      ] ?? "";
    const octave = octaves
      ? `, ${octaves} ${staff.clefDisPlace === "above" ? "higher" : "lower"}`
      : "";
    return `${staff.clefShape} clef on line ${staff.clefLine}${octave}`;
  }
  // A percussion staff has up to 5 lines; a tablature one line (string or
  // course) per string, 4 to 8.
  const linesChoices = (staff: StaffModel): number[] =>
    staff.clefShape === "perc" ? [1, 2, 3, 4, 5] : [4, 5, 6, 7, 8];
  const KEY_SIGNATURES = ["0", "1s", "2s", "3s", "4s", "5s", "6s", "7s"]
    .concat(["1f", "2f", "3f", "4f", "5f", "6f", "7f"])
    .map((value) => ({ value, label: keysigText(value) }));
  const METER_NAMES = { common: "Common time", cut: "Cut time" };
  const METER_KINDS = [
    { value: "numeric", label: "Numbers", glyph: "threeFour" },
    { value: "common", label: METER_NAMES.common, glyph: "common" },
    { value: "cut", label: METER_NAMES.cut, glyph: "cut" },
  ] as const;
  const METER_UNITS = [1, 2, 4, 8, 16];
  const MAX_STAVES = 24;

  // The form's working copy of the score definition.
  let staves = $state<StaffModel[]>([]);
  let groups = $state<StaffGroupModel[]>([]);
  let keysig = $state("0");
  // The time signature: numbers (count over unit), or one of the two MEI
  // symbols — common time (C) and cut time (¢).
  let meterType = $state<"numeric" | "common" | "cut">("numeric");
  let meterCount = $state("4");
  let meterUnit = $state("4");

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        staves = d.model.scoreDef.staves.map((s) => ({ ...s }));
        groups = d.model.scoreDef.groups.map((g) => ({ ...g }));
        // A loaded group's one-instrument value is kept, not guessed again.
        instrChosen.clear();
        groups.forEach((g) => instrChosen.add(g));
        keysig = d.model.scoreDef.keysig;
        meterType =
          d.model.scoreDef.meterSym === ""
            ? "numeric"
            : (d.model.scoreDef.meterSym as "common" | "cut");
        meterCount = d.model.scoreDef.meterCount;
        meterUnit = d.model.scoreDef.meterUnit;
        // An OMR-prepared piece still at the default definition opens with the
        // staff count its layout has; the clefs, key and meter follow from the
        // recognition once the task is held.
        unset =
          JSON.stringify(d.model.scoreDef) ===
          JSON.stringify(DEFAULT_SCORE_DEF);
        if (d.preparation === "omr" && unset) {
          staves = Array.from(
            { length: staffCountOf(d.model.pages) },
            plainStaff,
          );
        }
      },
      reset() {
        staves = [];
      },
      // A claim of an OMR piece's setup task continues into the piece's
      // recognition in the same overlay.
      afterClaim(f, d) {
        if (!(d.preparation === "omr" && session.canEdit)) return null;
        recognisedFor = taskId;
        return recognitionSteps(f, d);
      },
    },
  );
  const runner = session.runner;
  const data = $derived(session.data);
  const holds = $derived(session.holds);
  // Only the volunteer holding the task edits it; everyone else, and everyone
  // once it is done, sees its values read-only without the editing buttons.
  const canEdit = $derived(session.canEdit);
  const busy = $derived(session.busy);
  const owner = $derived(session.campaign.owner);
  const repo = $derived(session.campaign.repo);
  const repoId = $derived(session.campaign.repoId);
  const tables = $derived(session.tables);
  $effect(() => {
    if (tables) recordCampaignTitle(campaign, tables.title);
  });
  const viewer = $derived(session.viewer);

  // A count of 0, a blank, or anything non-numeric would emit a meter no
  // renderer can read, so the submission waits for a whole number above zero.
  // A symbol signature carries no count to get wrong.
  const meterValid = $derived(
    meterType !== "numeric" || /^[1-9]\d*$/.test(meterCount.trim()),
  );

  // Groups must fit the staves and nest without crossing (staff-groups.ts).
  const groupsValid = $derived(groupsFit(groups, staves.length));

  // A symbol signature implies its numeric meter — common time is 4/4, cut
  // time 2/2 — matching what parseScoreDef reads back.
  const scoreDef = $derived<ScoreDefModel>({
    staves: staves.map((s) => ({ ...s, label: s.label.trim() })),
    groups: groups.map((g) => ({ ...g, label: g.label.trim() })),
    keysig,
    meterCount:
      meterType === "numeric"
        ? meterCount.trim()
        : meterType === "cut"
          ? "2"
          : "4",
    meterUnit:
      meterType === "numeric" ? meterUnit : meterType === "cut" ? "2" : "4",
    meterSym: meterType === "numeric" ? "" : meterType,
  });

  const run = (
    command: (c: CommandContext) => Promise<Result>,
    opts?: { overviewOnSuccess?: boolean },
  ) => session.run(command, opts);

  // ------------------------------------------------------------- comments
  // The side panel beside the tool. Posting and resolving refresh the tables
  // only: a full reload would discard unsubmitted form values.
  let sidePanel = $state(readSidePanel());
  // The source side of the work area: the first measure's page, framed on
  // the measure and the names in front of its system, the measure outlined.
  // The first measure is the first zone of the first page with zones. Its
  // staves (`anchor`) run from the system's first staff to its last where
  // the layout has staff boxes (an OMR-prepared piece), else over the
  // measure's zone. The frame takes in the page from its left edge to the
  // measure's end and the staves with room above and below: 0.6 of a staff
  // box's height, or a tenth of the zone's. A comment anchor shows its page
  // whole until the fit button returns.
  const firstMeasure = $derived.by(() => {
    const i = data?.model.pages.findIndex((p) => p.zones.length > 0) ?? -1;
    if (!data || i < 0) return null;
    const pg = data.model.pages[i];
    const box = pg.zones[0].box;
    const system = pg.staves?.length ? pageSystems(pg).systems[0] : undefined;
    const staffBoxes = system?.length ? system : null;
    const anchor = staffBoxes
      ? { uly: staffBoxes[0].uly, lry: staffBoxes[staffBoxes.length - 1].lry }
      : { uly: box.uly, lry: box.lry };
    const pad = staffBoxes
      ? (0.6 * staffBoxes.reduce((sum, b) => sum + b.lry - b.uly, 0)) /
        staffBoxes.length
      : 0.1 * (box.lry - box.uly);
    return {
      page: i,
      box,
      staves: staffBoxes,
      anchor,
      frame: {
        ulx: 0,
        uly: Math.max(0, anchor.uly - pad),
        lrx: Math.min(pg.width, box.lrx + pad / 2),
        lry: Math.min(pg.height, anchor.lry + pad),
      },
    };
  });
  let anchorPage = $state<number | null>(null);
  $effect(() => {
    void taskId;
    anchorPage = null;
  });
  function showAnchorFor(c: CommentRow) {
    const p = commentAnchor(c).page - 1;
    anchorPage = data && p >= 0 && p < data.model.pages.length ? p : null;
  }
  const shownPage = $derived(anchorPage ?? firstMeasure?.page ?? 0);
  // The anchor a change request opens with: the page shown.
  const reviewPrefill = () => ({ page: String(shownPage + 1), m1: "", m2: "" });

  // Like for like: the source's first system is scaled and placed so its
  // staves line up with the preview's. With as many staves on both sides
  // the first and last staves meet; otherwise the staff spacing is matched,
  // from the first staff down.
  type StaffSpan = {
    top: number;
    lastTop: number;
    bottom: number;
    count: number;
  };
  // Each rendered staff's lines, in viewport coordinates.
  const staffLines = () =>
    staffEls().map((g) => {
      let top = Infinity;
      let bottom = -Infinity;
      for (const line of g.children) {
        if (line.tagName !== "path") continue;
        const r = line.getBoundingClientRect();
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      return { top, bottom };
    });
  function previewLines(): StaffSpan | null {
    const lines = staffLines();
    const first = lines[0];
    const last = lines[lines.length - 1];
    return first && last && last.bottom > first.top
      ? {
          top: first.top,
          lastTop: last.top,
          bottom: last.bottom,
          count: lines.length,
        }
      : null;
  }
  let previewStaves = $state<StaffSpan | null>(null);
  const measurePreviewStaves = () => (previewStaves = previewLines());
  /** The source's staves as image heights and the preview heights they
      meet, `top` being the preview's first staff. */
  function staffMatch(p: StaffSpan, fm: NonNullable<typeof firstMeasure>) {
    const boxes = fm.staves;
    if (!boxes || boxes.length === p.count || boxes.length < 2 || p.count < 2)
      return { ...fm.anchor, top: p.top, bottom: p.bottom };
    const scale =
      (p.lastTop - p.top) /
      (p.count - 1) /
      ((boxes[boxes.length - 1].uly - boxes[0].uly) / (boxes.length - 1));
    return {
      ...fm.anchor,
      top: p.top,
      bottom: p.top + (fm.anchor.lry - fm.anchor.uly) * scale,
    };
  }
  const align = $derived(
    previewStaves && firstMeasure && anchorPage === null
      ? staffMatch(previewStaves, firstMeasure)
      : null,
  );

  // The preview's size. The rendering is measured once per render, its
  // staves as fractions of its width; it is then drawn at the largest width
  // at which a staff is at most STAFF_MAX high, the rendering fits the
  // sheet, and, at the scale that lines the source up, the source's frame
  // and the preview's staves together fit the source's view: the frame's
  // part above the first staff, then the longer of the frame's part below
  // it and the preview's staves with a staff's height of room below the
  // last. That height is centred in the view, which
  // places the first staff on both sides.
  // While groups are marked, each staff keeps at least MARK_PITCH of height
  // up to the sheet's width, the sheet scrolling.
  const STAFF_MAX = 44;
  const MARK_PITCH = 32;
  let rendering = $state<
    (StaffSpan & { aspect: number; staffHeight: number }) | null
  >(null);
  $effect(() => {
    void previewSvg;
    void tick().then(() => {
      const svg = sheetEl?.querySelector("svg");
      const box = svg?.getBoundingClientRect();
      const vb = svg?.viewBox.baseVal;
      const p = previewLines();
      if (!box?.width || !box.height || !vb?.width || !vb.height || !p) return;
      // The drawing is fitted into the element's box and centred in it, so
      // where the box is cut to the sheet's height it is narrower than the
      // box.
      const scale = Math.min(box.width / vb.width, box.height / vb.height);
      const w = vb.width * scale;
      const top = box.top + (box.height - vb.height * scale) / 2;
      rendering = {
        top: (p.top - top) / w,
        lastTop: (p.lastTop - top) / w,
        bottom: (p.bottom - top) / w,
        count: p.count,
        aspect: vb.height / vb.width,
        staffHeight: Math.max(...staffLines().map((l) => l.bottom - l.top)) / w,
      };
    });
  });
  // The facsimile box and the sheet inside its border, in CSS pixels. The
  // sheet's content lies inside its padding (.sheet), 9px below the top of
  // the facsimile box with the border.
  let facsW = $state(0);
  let facsH = $state(0);
  let sheetW = $state(0);
  let sheetH = $state(0);
  const SHEET_PAD = { top: 9, x: 36, y: 16 };
  const previewSize = $derived.by(() => {
    const r = rendering;
    const cw = sheetW - SHEET_PAD.x;
    const ch = sheetH - SHEET_PAD.y;
    if (!r || cw <= 0 || ch <= 0) return null;
    let width = Math.min(cw, STAFF_MAX / Math.max(r.staffHeight, 1e-6));
    const fm = firstMeasure;
    const facs =
      fm && anchorPage === null && data?.imageUrls[fm.page] && facsW && facsH;
    const m = facs ? staffMatch(r, fm) : null;
    const room = fitRoom(facsW, facsH);
    // Per unit of the preview's width: the source's scale, and the heights
    // above and below the first staff.
    let kw = 0;
    let above = 0;
    let below = 0;
    if (m && fm) {
      kw = (m.bottom - m.top) / (m.lry - m.uly);
      above = (fm.anchor.uly - fm.frame.uly) * kw;
      below = Math.max(
        (fm.frame.lry - fm.anchor.uly) * kw,
        r.bottom - r.top + r.staffHeight,
      );
      width = Math.min(
        width,
        room.width / ((fm.frame.lrx - fm.frame.ulx) * kw),
        room.height / (above + below),
      );
    } else width = Math.min(width, ch / r.aspect);
    if (markable && r.count > 1)
      width = Math.min(
        cw,
        Math.max(width, (MARK_PITCH * (r.count - 1)) / (r.lastTop - r.top)),
      );
    let offset = 0;
    if (kw) {
      const staffTop =
        room.top +
        Math.max(0, (room.height - (above + below) * width) / 2) +
        above * width;
      offset = Math.max(0, staffTop - SHEET_PAD.top - r.top * width);
    }
    return { width: Math.floor(width), offset: Math.round(offset) };
  });

  // Dragging the divider, or its arrow keys, moves the boundary between the
  // source and the preview; each keeps at least a fifth of the width.
  let desk = $state<HTMLDivElement>();
  let splitting = false;
  const clampSplit = (v: number) => Math.min(0.8, Math.max(0.2, v));
  function splitDown(e: PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    splitting = true;
  }
  // One update per frame, however often the pointer moves.
  let splitFrame = 0;
  function splitMove(e: PointerEvent) {
    if (!splitting || !desk) return;
    const box = desk.getBoundingClientRect();
    const to = clampSplit((e.clientX - box.left) / box.width);
    cancelAnimationFrame(splitFrame);
    splitFrame = requestAnimationFrame(() => (split[setupStep] = to));
  }
  const splitUp = () => (splitting = false);
  function splitKey(e: KeyboardEvent) {
    const d = e.key === "ArrowLeft" ? -0.05 : e.key === "ArrowRight" ? 0.05 : 0;
    if (!d) return;
    e.preventDefault();
    split[setupStep] = clampSplit(split[setupStep] + d);
  }

  const submit = () =>
    run(
      (c) =>
        invoke(
          commands.submitScoreSetup,
          {
            task_id: taskId,
            scoreDef,
            ...(omr && recognition
              ? {
                  omr: serializeOmrRecord(
                    withClefCorrections(recognition.record),
                  ),
                }
              : {}),
          },
          c,
        ),
      { overviewOnSuccess: true },
    );

  // ------------------------------------------------------------------------
  // Recognition (OMR-prepared pieces)
  //
  // When the claim holder opens the task, every staff box of the piece is
  // transcribed and its instrument label read; the record goes into the
  // submission as `omr.xml`, which the page drafts are made from. Staves the
  // head's record or this browser already holds are not transcribed again.
  //
  // A definition still at the default is filled in from the record. The
  // staff count starts from the layout correction. Each staff's clef is the
  // one it opens with where it first appears (a first system may leave a
  // staff out, a resting voice above a piano introduction), placed by the
  // system with the most staves; key and meter come from the piece's first
  // system, where signatures are printed. A clef submitted other than the
  // one read is recorded as a correction: the page drafts then read that
  // staff in the submitted clef until the model reads a real change. The instrument
  // labels are those read in front of the first system, where they are
  // usually written out, and in front of the fullest system for a staff the
  // first leaves out; a staff that already has a label keeps it. Braces come
  // from the corrected grand-staff boxes of the fullest system; brackets are
  // not recognised. The count stays editable until the piece holds notation,
  // since the setup submission rebuilds empty measures for it until then.
  const omr = $derived(data?.preparation === "omr");
  // The form sits in the side panel. Docked below the score as a sheet
  // (DOCKED_QUERY) it shows one section at a time, chosen by a switch.
  const dockedQuery = new MediaQuery(DOCKED_QUERY, false);
  const docked = $derived(dockedQuery.current);
  // The setup's two steps: the staves with the key and time signature, then
  // the groups.
  let setupStep = $state<1 | 2>(1);
  let panelTab = $state<"selection" | "comments">("selection");
  // Whether the file still carries the default definition (set on load).
  let unset = $state(false);
  let recognition = $state<PieceRecognition | null>(null);
  let recognisedFor = $state<string | null>(null);
  $effect(() => {
    void taskId;
    recognition = null;
  });

  // While the task is held, its definition (and the recognition record this
  // session made) is saved as a draft after each pause in editing.
  $effect(() => {
    if (!session.canEdit || staves.length === 0) return;
    session.draft({
      scoreDef,
      ...(omr && recognition
        ? {
            omr: serializeOmrRecord(withClefCorrections(recognition.record)),
          }
        : {}),
    });
  });

  /** Clef tokens of the form's staves for placing the boxes. */
  const formParts = () =>
    staves.map((s) => ({
      clef:
        s.clefShape === "perc" || s.clefShape === "TAB"
          ? s.clefShape
          : `${s.clefShape}${s.clefLine}`,
      label: s.label.trim(),
    }));
  const pitched = (token: string) => /^[GFC]\d/.test(token);
  /**
   * The record with a clef correction for each staff submitted in another
   * clef than it opens with in the recognition, the boxes placed on the
   * form's staves as the page drafts will place them.
   */
  function withClefCorrections(record: OmrRecord): OmrRecord {
    const readClefs = data
      ? openingClefs(
          pieceStaves(data.model, { ...record, clefs: [] }, formParts()),
          staves.length,
        )
      : [];
    const clefs = staves.flatMap((staff, i) => {
      const read = readClefs[i];
      const corrected = staffClefToken(staff);
      return read && read !== corrected && pitched(read) && pitched(corrected)
        ? [{ staff: i + 1, read, corrected }]
        : [];
    });
    return { ...record, clefs };
  }
  $effect(() => {
    if (omr && canEdit && data && !runner.busy && recognisedFor !== taskId) {
      recognisedFor = taskId;
      recognise();
    }
  });

  function applyProposal(proposal: ScoreDefModel) {
    // A clef per staff the layout has; a staff beyond the recognised system
    // keeps its own. Labels stay.
    staves = staves.map((s, i) =>
      proposal.staves[i] ? { ...proposal.staves[i], label: s.label } : s,
    );
    keysig = proposal.keysig;
    meterType =
      proposal.meterSym === ""
        ? "numeric"
        : (proposal.meterSym as "common" | "cut");
    meterCount = proposal.meterCount;
    meterUnit = proposal.meterUnit;
  }

  async function recognise() {
    const f = forge();
    if (!f || !data) return;
    const d = data;
    await runner.run(() => recognitionSteps(f, d));
  }

  /** The definition proposed from a record, and the labels it reads; a note says what was used. */
  function proposalFrom(
    d: FacsimileTaskData,
    record: OmrRecord,
  ): { note: string } {
    type System = { p: number; index: number; staves: MeasureBox[] };
    let first: System | null = null;
    let fullest: System | null = null;
    for (const [p, pg] of d.model.pages.entries()) {
      for (const [index, system] of pageSystems(pg).systems.entries()) {
        if (!system.length) continue;
        first ??= { p, index, staves: system };
        if (!fullest || system.length > fullest.staves.length)
          fullest = { p, index, staves: system };
      }
    }
    if (!first || !fullest)
      throw new Error("the layout has no system with staves.");
    const same = first.p === fullest.p && first.index === fullest.index;
    const entriesOf = (system: System) =>
      system.staves.map((box) => {
        const zone = `staff-zone-${system.p + 1}-${d.model.pages[system.p].staves!.indexOf(box) + 1}`;
        return (
          record.pages
            .find((pg) => pg.n === system.p + 1)
            ?.staves.find((e) => e.zone === zone) ?? null
        );
      });
    const fullestEntries = entriesOf(fullest);
    const firstEntries = same ? fullestEntries : entriesOf(first);
    const fullestXmls = fullestEntries.map((e) => e?.musicxml ?? null);
    const firstXmls = firstEntries.map((e) => e?.musicxml ?? null);
    const proposal = proposeScoreDef(fullestXmls, same ? [] : firstXmls);
    // Each staff opens in the clef of its first appearance, placed by the fullest system's clefs.
    const placedBy = proposal.staves.map((staff) => ({
      clef:
        staff.clefShape === "perc" || staff.clefShape === "TAB"
          ? staff.clefShape
          : `${staff.clefShape}${staff.clefLine}`,
      label: "",
    }));
    openingClefs(
      pieceStaves(d.model, { ...record, clefs: [] }, placedBy),
      proposal.staves.length,
    ).forEach((token, i) => {
      if (token)
        proposal.staves[i] = { ...proposal.staves[i], ...clefStaff(token) };
    });
    applyProposal(proposal);

    // The fullest system shows every staff of the definition, in order.
    const read = fullestEntries.map((e) => e?.label ?? "");
    if (!same) {
      const token = (staff: StaffModel) =>
        staff.clefShape === "perc" || staff.clefShape === "TAB"
          ? staff.clefShape
          : `${staff.clefShape}${staff.clefLine}`;
      const onFirst = suggestStaffAssignment(
        first.staves.map((box, i) => ({
          box,
          clef: clefToken(firstXmls[i]),
          label: "",
        })),
        proposal.staves.map((staff) => ({ clef: token(staff), label: "" })),
        fullest.staves,
      );
      onFirst.forEach((n, i) => {
        const label = firstEntries[i]?.label;
        if (n > 0 && label) read[n - 1] = label;
      });
    }
    let filled = 0;
    staves = staves.map((staff, i) => {
      if (staff.label.trim() || !read[i]) return staff;
      filled++;
      return { ...staff, label: read[i] };
    });
    staves.forEach(fillFromLabel);
    // The fullest system's grand-staff boxes become braces, unless the
    // definition has groups already; a span repeating or crossing an earlier
    // one is left out.
    const braces: StaffGroupModel[] = [];
    if (!groups.length)
      for (const { start, end } of grandStaffSpans(
        fullest.staves,
        d.model.pages[fullest.p].grandstaves ?? [],
      )) {
        const repeated = braces.some((b) => b.start === start && b.end === end);
        if (!repeated && !spanProblem(braces, start, end))
          braces.push(newGroup(start, end, "brace"));
      }
    if (braces.length) groups = braces;
    const clefs = proposal.staves
      .map(
        (s) =>
          `${s.clefShape}${s.clefLine}${s.clefDis ? ` ${s.clefDis}${s.clefDisPlace === "below" ? "vb" : "va"}` : ""}`,
      )
      .join(", ");
    const meter =
      proposal.meterSym || `${proposal.meterCount}/${proposal.meterUnit}`;
    return {
      note:
        ` Filled in: clefs ${clefs}, each where its staff first appears; key signature ${proposal.keysig} and time signature ${meter} from the first system; instrument labels for ${filled} of ${staves.length} staves${braces.length ? `; ${braces.length} brace${braces.length === 1 ? "" : "s"} from the grand staves` : ""}.` +
        " Check the values, then submit.",
    };
  }

  // The recognition steps, logged to the running command's overlay.
  async function recognitionSteps(
    f: ForgeClient,
    d: FacsimileTaskData,
  ): Promise<Result> {
    const client = createOmrClient(provider.brokerUrl);
    // A run finishing after the page moved to another task is dropped.
    const task = taskId;
    try {
      runner.log.step("Reading the recognition record");
      // A record saved with the work, or kept from an expired claim, comes
      // before the campaign's.
      const from = d.workSource ?? { owner, repo, ref: undefined };
      const existing =
        recognition?.record ??
        parseOmrRecord(
          await f.getRepoFile(
            from.owner,
            from.repo,
            omrRecordPath(d.fragment),
            from.ref,
          ),
        );
      const result = await recognisePiece({
        forge: f,
        client,
        owner,
        repo,
        repoId,
        fragment: d.fragment,
        pages: d.model.pages,
        existing,
        pipeline: omrModels.staffPipeline,
        progress: (step) => runner.log.step(step),
      });
      if (task !== taskId)
        return {
          error: "The recognition finished after another task was opened.",
        };
      recognition = result;
      const total = result.record.pages.reduce(
        (n, pg) => n + pg.staves.length,
        0,
      );
      const failed = result.failed.length
        ? ` ${result.failed.length} of ${total} staves could not be transcribed (${result.failed
            .map((s) => `page ${s.page}, staff ${s.staff}`)
            .join("; ")}); use “Transcribe failed staves again”.`
        : "";
      const labels = result.labelErrors.length
        ? ` The instrument labels could not be read on page${result.labelErrors.length === 1 ? "" : "s"} ${result.labelErrors.map((e) => e.page).join(", ")} (${result.labelErrors[0].error}).`
        : "";
      const filled = unset ? proposalFrom(d, result.record).note : "";
      unset = false;
      return {
        ok: true,
        warn: result.failed.length > 0 || result.labelErrors.length > 0,
        message: `${total - result.failed.length} of ${total} staves are transcribed.${failed}${labels}${filled}`,
      };
    } catch (e) {
      return { error: `Recognition failed: ${(e as Error).message}` };
    }
  }

  // ------------------------------------------------------------------------
  // The form

  const plainStaff = (): StaffModel => ({
    clefShape: "G",
    clefLine: 2,
    clefDis: "",
    clefDisPlace: "",
    lines: 5,
    notationType: "",
    label: "",
  });
  function addStaff() {
    if (staves.length >= MAX_STAVES) return;
    staves = [...staves, plainStaff()];
  }
  // ------------------------------------------------------------------------
  // Staff groups
  //
  // A group is made in step 2 by marking its staves in the preview (the
  // first staff, then the last: a click or tap on each, or a mouse drag from
  // one to the other) and choosing its symbol. Its values are edited in its
  // row in the panel, opened from its line or from a marked staff.
  const newGroup = (
    start: number,
    end: number,
    symbol: string,
  ): StaffGroupModel => ({
    start,
    end,
    symbol,
    label: "",
    barThru: true,
    oneInstrument:
      symbol === "brace" &&
      guessOneInstrument({ start, end, label: "" }, staves),
  });
  // Groups whose one-instrument value the volunteer set or the file holds;
  // the others follow the guess from the labels and clefs.
  const instrChosen = new SvelteSet<StaffGroupModel>();
  $effect(() => {
    for (const g of groups) {
      if (instrChosen.has(g)) continue;
      const guess = g.symbol === "brace" && guessOneInstrument(g, staves);
      if (g.oneInstrument !== guess) g.oneInstrument = guess;
    }
  });
  function setOneInstrument(g: StaffGroupModel, value: boolean) {
    g.oneInstrument = value;
    instrChosen.add(g);
  }
  // The marked staves, 0-based: the first, then the last (null until marked).
  let markFrom = $state<number | null>(null);
  let markTo = $state<number | null>(null);
  let openGroup = $state<StaffGroupModel | null>(null);
  let hoveredGroup = $state<StaffGroupModel | null>(null);
  // While a reviewer's change request form is open (ReviewActions), a click
  // on a staff (on the page or in the summary) or on a group in the summary
  // fills its staff field.
  let reviewAsking = $state(false);
  let staffPick = $state<{ text: string } | null>(null);
  function pickStaff(i: number) {
    if (!reviewAsking) return;
    const label = staves[i]?.label;
    staffPick = { text: label ? `${i + 1} (${label})` : `${i + 1}` };
  }
  function pickGroup(g: StaffGroupModel) {
    if (!reviewAsking) return;
    staffPick = { text: `${g.start}–${g.end} (${g.symbol})` };
  }
  let announce = $state("");
  const openG = $derived(
    openGroup && groups.includes(openGroup) ? openGroup : null,
  );
  const ordered = $derived(sortGroups(groups));
  // The summary's columns for the groups beside the staves: one per level
  // of nesting.
  const groupColumns = $derived(
    groups.reduce((n, g) => Math.max(n, groupDepth(groups, g) + 1), 0),
  );
  const marked = $derived(
    markFrom === null
      ? null
      : {
          start: Math.min(markFrom, markTo ?? markFrom) + 1,
          end: Math.max(markFrom, markTo ?? markFrom) + 1,
        },
  );
  const markSpan = $derived(markTo === null ? null : marked);
  const sameGroup = $derived(
    markSpan
      ? groups.find((g) => g.start === markSpan.start && g.end === markSpan.end)
      : undefined,
  );
  const markProblem = $derived(
    markSpan && !sameGroup
      ? spanProblem(groups, markSpan.start, markSpan.end)
      : null,
  );
  const liveText = $derived(markProblem ?? announce);
  const symbolName = (symbol: string) =>
    symbol === "brace" ? "Brace" : "Bracket";
  const symbolGlyph = (symbol: string): MusicGlyphName =>
    symbol === "brace" ? "brace" : "bracket";
  /** "staves 7–8 · Pianoforte · one instrument · barlines through" */
  const groupText = (g: StaffGroupModel) =>
    [
      `staves ${g.start}–${g.end}`,
      g.label.trim(),
      g.symbol === "brace"
        ? g.oneInstrument
          ? "one instrument"
          : "separate staves"
        : "",
      g.barThru ? "barlines through" : "barlines per staff",
    ]
      .filter(Boolean)
      .join(" · ");
  /** The groups holding staff `n` (1-based), outer first. */
  const containing = (n: number) =>
    ordered.filter((g) => g.start <= n && n <= g.end);
  function clearMark() {
    markFrom = null;
    markTo = null;
  }
  function addMarked(symbol: string) {
    if (!markSpan || markProblem || sameGroup) return;
    const { start, end } = markSpan;
    groups = [...groups, newGroup(start, end, symbol)];
    openGroup = groups[groups.length - 1];
    announce = `${symbolName(symbol)} added over staves ${start}–${end}.`;
    clearMark();
  }
  function toggleRow(g: StaffGroupModel) {
    openGroup = openG === g ? null : g;
    clearMark();
  }
  // "Add group", the path without the preview: the first two neighbouring
  // staves a new group can join.
  const freePair = $derived.by(() => {
    for (let n = 1; n < staves.length; n++) {
      const taken = groups.some((g) => g.start === n && g.end === n + 1);
      if (!taken && !spanProblem(groups, n, n + 1)) return n;
    }
    return null;
  });
  function addGroup() {
    if (freePair === null) return;
    groups = [...groups, newGroup(freePair, freePair + 1, "brace")];
    openGroup = groups[groups.length - 1];
    clearMark();
  }
  function removeGroup(g: StaffGroupModel) {
    groups = groups.filter((h) => h !== g);
    announce = `${symbolName(g.symbol)} over staves ${g.start}–${g.end} removed.`;
  }
  /** Whether the groups stay valid with one group's values changed. */
  const fitsWith = (g: StaffGroupModel, change: Partial<StaffGroupModel>) =>
    groupsFit(
      groups.map((h) => (h === g ? { ...h, ...change } : h)),
      staves.length,
    );
  function setClef(staff: StaffModel, key: string) {
    const option = CLEF_OPTIONS.find((o) => o.value === key);
    if (!option) return;
    staff.clefShape = option.clefShape;
    staff.clefDis = option.clefDis;
    staff.clefDisPlace = option.clefDis ? "below" : "";
    staff.notationType = option.notationType;
    staff.clefLine = option.clefLine;
    staff.lines = option.lines;
    // Percussion and tablature staves do not transpose or carry a key.
    if (unpitched(staff)) {
      setTransposition(staff, null);
      delete staff.keysig;
    }
  }

  // Transposition and key per staff. A staff's key follows the score's,
  // moved by its transposition, unless it has its own (`keysig`); a key set
  // equal to the one it would follow is dropped, so it keeps following.
  const transOf = (staff: StaffModel): Transposition => ({
    diat: staff.transDiat ?? 0,
    semi: staff.transSemi ?? 0,
  });
  const transposes = (staff: StaffModel) =>
    !!(staff.transDiat || staff.transSemi);
  const followedKey = (staff: StaffModel) =>
    writtenKeysig(keysig, transOf(staff));
  function settleKey(staff: StaffModel) {
    if (staff.keysig !== undefined && staff.keysig === followedKey(staff))
      delete staff.keysig;
  }
  function setTransposition(staff: StaffModel, t: Transposition | null) {
    if (t && (t.diat || t.semi)) {
      staff.transDiat = t.diat;
      staff.transSemi = t.semi;
    } else {
      delete staff.transDiat;
      delete staff.transSemi;
    }
    settleKey(staff);
  }
  // Staves whose transposition the volunteer chose, which a label no longer
  // fills, and those showing the pitch fields although a listed
  // transposition matches.
  const transChosen = new SvelteSet<StaffModel>();
  const transCustom = new SvelteSet<StaffModel>();
  /** The transposition select's value: 'none', a list index, or 'other'. */
  function transValue(staff: StaffModel): string {
    if (transCustom.has(staff)) return "other";
    if (!transposes(staff)) return "none";
    const i = COMMON_TRANSPOSITIONS.findIndex(
      (t) => t.diat === staff.transDiat && t.semi === staff.transSemi,
    );
    return i < 0 ? "other" : String(i);
  }
  function pickTransposition(staff: StaffModel, value: string) {
    transChosen.add(staff);
    if (value === "other") {
      transCustom.add(staff);
      return;
    }
    transCustom.delete(staff);
    setTransposition(
      staff,
      value === "none" ? null : COMMON_TRANSPOSITIONS[Number(value)],
    );
  }
  /** The pitch fields of a staff with a transposition outside the list. */
  const customOf = (staff: StaffModel) =>
    toCustom(transOf(staff)) ?? { pitch: "C", higher: false, octaves: 0 };
  function setCustom(
    staff: StaffModel,
    change: Partial<ReturnType<typeof customOf>>,
  ) {
    setTransposition(staff, fromCustom({ ...customOf(staff), ...change }));
  }
  /** Fill a staff's transposition from its label, unless one is set or was chosen. */
  function fillFromLabel(staff: StaffModel) {
    if (transChosen.has(staff) || transposes(staff) || unpitched(staff)) return;
    const t = transpositionFromLabel(staff.label);
    if (t) setTransposition(staff, t);
  }
  // Labels already in the file or a saved draft fill the transpositions
  // once the holder opens the task.
  let labelsReadFor = $state<string | null>(null);
  $effect(() => {
    if (!canEdit || staves.length === 0 || labelsReadFor === taskId) return;
    labelsReadFor = taskId;
    untrack(() => staves.forEach(fillFromLabel));
  });
  /** "in B♭, sounds a major 2nd lower", or '' for a staff that does not transpose. */
  function transText(staff: StaffModel): string {
    if (!transposes(staff)) return "";
    const c = toCustom(transOf(staff));
    const pitch =
      c && !(c.pitch === "C" && c.octaves > 0) ? `in ${c.pitch}, ` : "";
    return `${pitch}sounds ${soundsText(transOf(staff))}`;
  }
  const STAFF_KEYS = KEY_SIGNATURES;
  function removeStaff(i: number) {
    if (staves.length <= 1) return;
    groups = removeStaffFromGroups(groups, i);
    clearMark();
    staves = staves.filter((_, n) => n !== i);
  }
  function moveStaff(from: number, to: number) {
    if (from === to || to < 0 || to >= staves.length) return;
    groups = moveStaffInGroups(groups, staves.length, from, to);
    clearMark();
    reorderStaves(from, to);
  }
  function reorderStaves(from: number, to: number) {
    const next = [...staves];
    const [staff] = next.splice(from, 1);
    next.splice(to, 0, staff);
    staves = next;
  }

  // Reordering by a staff's handle (its number): dragged, the staff takes
  // the place of each row the pointer crosses, and the list scrolls near its
  // container's edges. A click picks the staff and a click on another
  // staff's handle moves it there; the arrow keys move it by one.
  let staffList = $state<HTMLOListElement | null>(null);
  let dragging = $state<number | null>(null);
  let picked = $state<number | null>(null);
  // A drag's groups follow one move from the row it began on, as a click
  // move would: each row crossed starts again from the groups' ranges then.
  let gesture: {
    x: number;
    y: number;
    moved: boolean;
    origin: number;
    groups: { g: StaffGroupModel; start: number; end: number }[];
  } | null = null;
  let swallowClick = false;
  function handleDown(i: number, e: PointerEvent) {
    if (e.button !== 0) return;
    gesture = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      origin: i,
      groups: groups.map((g) => ({ g, start: g.start, end: g.end })),
    };
    dragging = i;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function handleMove(e: PointerEvent) {
    if (!gesture || dragging === null || !staffList) return;
    if (!gesture.moved) {
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 4) return;
      gesture.moved = true;
      picked = null;
    }
    const rows = [...staffList.children] as HTMLElement[];
    const over = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return e.clientY >= box.top && e.clientY < box.bottom;
    });
    if (over >= 0 && over !== dragging) {
      for (const { g, start, end } of gesture.groups) {
        g.start = start;
        g.end = end;
      }
      groups = moveStaffInGroups(
        gesture.groups.map(({ g }) => g),
        staves.length,
        gesture.origin,
        over,
      );
      clearMark();
      reorderStaves(dragging, over);
      dragging = over;
    }
    let scroller = staffList.parentElement;
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    if (e.clientY < box.top + 40) scroller.scrollTop -= 10;
    else if (e.clientY > box.bottom - 40) scroller.scrollTop += 10;
  }
  function handleUp() {
    swallowClick = !!gesture?.moved;
    gesture = null;
    dragging = null;
  }
  function handleClick(i: number) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (picked === null) picked = i;
    else {
      moveStaff(picked, i);
      picked = null;
    }
  }
  async function handleKey(i: number, e: KeyboardEvent) {
    const to =
      e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : null;
    if (e.key === "Escape") picked = null;
    if (to === null || to < 0 || to >= staves.length) return;
    e.preventDefault();
    moveStaff(i, to);
    await tick();
    staffList?.querySelectorAll<HTMLElement>(".staffgrip")[to]?.focus();
  }
  const handleTitle = (i: number) =>
    picked === null
      ? "Drag to move this staff. Or click it, then click the staff whose place it takes. The arrow keys move it up and down."
      : picked === i
        ? "Click again to leave this staff where it is."
        : `Click to move staff ${picked + 1} here.`;

  // ------------------------------------------------------------------------
  // Preview
  //
  // The opening of the score with the values on screen, rendered as one seed
  // measure so the staves, clefs, key signature and meter can be read back
  // before they are submitted. A one-measure blank score rather than the full
  // rebuild: a facsimile piece has no measures to render before its measure
  // correction runs.
  let previewSvg = $state("");
  let previewError = $state("");
  $effect(() => {
    const model = scoreDef;
    if (!data || !meterValid || !groupsValid) return;
    const mei = buildBlankScoreMei(data.model.headXml, 0, model);
    let dropped = false;
    getVerovio()
      .then((tk) => {
        if (dropped) return;
        if (!loadSnippet(tk, mei))
          throw new Error("the score could not be rendered.");
        previewSvg = renderPage(tk, 1);
        previewError = "";
      })
      .catch((e: Error) => {
        if (!dropped) previewError = `No preview: ${e.message}`;
      });
    return () => (dropped = true);
  });

  // The staves a row of the form or the summary points at (hovered, else
  // focused), the marked staves and the open group's are coloured in the
  // preview: the rendered measure's staves are in staff order.
  let sheetEl = $state<HTMLElement | null>(null);
  let hoveredStaff = $state<number | null>(null);
  let focusedStaff = $state<number | null>(null);
  const pointedStaff = $derived(hoveredStaff ?? focusedStaff);
  const staffEls = () => [
    ...(sheetEl?.querySelectorAll<SVGGElement>("g.measure > g.staff") ?? []),
  ];
  // Groups are marked in step 2, by the volunteer holding the task.
  const markable = $derived(canEdit && setupStep === 2 && staves.length > 1);
  const lit = $derived.by(() => {
    if (markable && marked) return marked;
    const g = hoveredGroup ?? (setupStep === 2 ? openG : null);
    if (g) return { start: g.start, end: g.end };
    return pointedStaff === null
      ? null
      : { start: pointedStaff + 1, end: pointedStaff + 1 };
  });
  $effect(() => {
    void previewSvg;
    const range = lit;
    staffEls().forEach((g, i) =>
      g.classList.toggle(
        "pointed",
        !!range && i + 1 >= range.start && i + 1 <= range.end,
      ),
    );
  });

  // The staff numbers beside the preview, for orientation: each at the
  // middle of its rendered staff, measured in the sheet's scrolled content,
  // again after every render and every change of the sheet's size.
  let staffMarks = $state<number[]>([]);
  function placeStaffMarks() {
    const el = sheetEl;
    if (!el) return;
    const top = el.getBoundingClientRect().top - el.scrollTop;
    staffMarks = staffEls().map((g) => {
      const box = g.getBoundingClientRect();
      return (box.top + box.bottom) / 2 - top;
    });
  }
  $effect(() => {
    void previewSvg;
    void previewSize;
    const el = sheetEl;
    if (!el) return;
    const place = () => {
      placeStaffMarks();
      measurePreviewStaves();
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    const svg = el.querySelector("svg");
    if (svg) observer.observe(svg);
    // The source follows the preview scrolled while groups are marked.
    el.addEventListener("scroll", measurePreviewStaves, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measurePreviewStaves);
    };
  });

  // Marking: a staff's target is the band of the preview's full width
  // nearest its middle. A click or tap marks the first staff, then the last;
  // a mouse drag marks both at once. On touch a drag scrolls the preview.
  function staffAt(y: number): number | null {
    let best: number | null = null;
    let distance = Infinity;
    staffEls().forEach((g, i) => {
      const box = g.getBoundingClientRect();
      const d = Math.abs(y - (box.top + box.bottom) / 2);
      if (d < distance) {
        distance = d;
        best = i;
      }
    });
    return best;
  }
  let dragFrom: number | null = null;
  let dragMoved = false;
  function sheetDown(e: PointerEvent) {
    if (!markable || e.pointerType !== "mouse" || e.button !== 0) return;
    dragFrom = staffAt(e.clientY);
    dragMoved = false;
  }
  function sheetMove(e: PointerEvent) {
    if (dragFrom === null || !(e.buttons & 1)) return;
    const i = staffAt(e.clientY);
    if (i === null || (i === dragFrom && !dragMoved)) return;
    dragMoved = true;
    markFrom = dragFrom;
    markTo = i;
    openGroup = null;
  }
  function sheetClick(e: MouseEvent) {
    dragFrom = null;
    if (reviewAsking) {
      const i = staffAt(e.clientY);
      if (i !== null) pickStaff(i);
      return;
    }
    if (!markable) return;
    if (dragMoved) {
      dragMoved = false;
      return;
    }
    const i = staffAt(e.clientY);
    if (i === null) return;
    openGroup = null;
    if (markFrom === null || markTo !== null) {
      markFrom = i;
      markTo = null;
    } else if (i === markFrom) clearMark();
    else markTo = i;
  }

  const pointAt = (i: number) => ({
    onmouseenter: () => (hoveredStaff = i),
    onmouseleave: () => (hoveredStaff = null),
    onfocusin: () => (focusedStaff = i),
    onfocusout: (e: FocusEvent) => {
      const row = e.currentTarget as HTMLElement;
      if (!row.contains(e.relatedTarget as Node | null)) focusedStaff = null;
    },
  });

  const coarseQuery = new MediaQuery("(pointer: coarse)", false);
  const tapWord = $derived(coarseQuery.current ? "Tap" : "Click");
  // Docked, the sheet shows the marking line or the open group until it is
  // opened; the list of groups is in the opened sheet.
  let sheetOpen = $state(false);
  const compact = $derived(docked && !sheetOpen);
  function goStep(step: 1 | 2) {
    setupStep = step;
    clearMark();
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && markFrom !== null) clearMark();
  }}
/>

<svelte:head>
  <title>Score setup · {session.pieceName || campaign} · Let's Encode!</title>
</svelte:head>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

<!-- On touch screens a long press opens no context menu (Android's save
     image menu) outside text fields and comment text. -->
<div
  class="corrector sidehost"
  data-stage="pre"
  role="presentation"
  oncontextmenu={(e) => {
    if (
      coarseQuery.current &&
      !(e.target as Element).closest(
        "input, textarea, [contenteditable], .cbody",
      )
    )
      e.preventDefault();
  }}
>
  {#if session.campaign.error}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {session.campaign.error}
          <button
            type="button"
            class="linkish"
            onclick={() => session.campaign.retry()}>Try again</button
          >
        </span>
      </div>
    </div>
  {:else if session.campaign.notFound}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          No campaign called <code>{campaign}</code> was found.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    </div>
  {:else if auth.status === "loading" || !session.campaign.resolved}
    <div class="deskwrap"><p class="muted">Loading…</p></div>
  {:else if !auth.user}
    <div class="deskwrap">
      <div class="banner warn">
        <span>
          {#if auth.expired}Your GitHub login has expired.{/if}
          Please
          <button type="button" class="linkish" onclick={() => login()}
            >log in with GitHub</button
          >
          to work on this task.
        </span>
      </div>
    </div>
  {:else if session.loading}
    <div class="deskwrap"><p class="muted">Loading the score…</p></div>
  {:else if session.loadError}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {session.loadError}
          <button type="button" class="linkish" onclick={() => session.load()}
            >Try again</button
          >
        </span>
      </div>
    </div>
  {:else if data}
    <!-- The work area: the source's first measure beside the preview of
         the setup, split by a divider that moves the boundary. A piece
         without page images has the preview alone. -->
    <div class="main">
      <h1 class="vh">Score setup · {session.pieceName || campaign}</h1>
      <TaskRunState task={taskId} bar />
      <div class="desk" bind:this={desk}>
        {#if firstMeasure && data.imageUrls[shownPage]}
          {@const pg = data.model.pages[shownPage]}
          <section
            class="facscol"
            style:flex-basis={`${split[setupStep] * 100}%`}
            aria-label="Source"
          >
            <span class="page-label"
              >{anchorPage === null
                ? "Source · first measure"
                : `Source · page ${shownPage + 1}`}</span
            >
            <div
              class="facsbox"
              bind:clientWidth={facsW}
              bind:clientHeight={facsH}
            >
              <FacsimileFrame
                url={data.imageUrls[shownPage]}
                width={pg.width}
                height={pg.height}
                frame={anchorPage === null
                  ? firstMeasure.frame
                  : { ulx: 0, uly: 0, lrx: pg.width, lry: pg.height }}
                mark={shownPage === firstMeasure.page
                  ? firstMeasure.box
                  : undefined}
                label={`Page ${shownPage + 1} of the source`}
                fitLabel="Show the first measure"
                away={anchorPage !== null}
                onfit={() => (anchorPage = null)}
                {align}
              />
            </div>
          </section>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            class="pane-grip"
            role="separator"
            tabindex="0"
            aria-label="Resize the source and the preview"
            aria-orientation="vertical"
            aria-valuenow={Math.round(split[setupStep] * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            onpointerdown={splitDown}
            onpointermove={splitMove}
            onpointerup={splitUp}
            onpointercancel={splitUp}
            onkeydown={splitKey}
          ></div>
        {/if}
        <section class="previewbox" aria-label="Preview of the setup">
          <span class="page-label">Preview of the setup</span>
          {#if !meterValid}
            <p class="muted">
              Enter a whole number of beats to see the preview.
            </p>
          {:else if !groupsValid}
            <p class="muted">Fix the staff groups to see the preview.</p>
          {:else if previewError}
            <p class="muted">{previewError}</p>
          {:else if previewSvg}
            <!-- In step 2 the staves take clicks and taps; the Groups section
                 of the panel is the path without a pointer. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div
              class="sheet"
              class:marking={markable}
              class:picking={reviewAsking}
              class:sized={!!previewSize}
              style:--w={previewSize ? `${previewSize.width}px` : null}
              style:--offset={previewSize ? `${previewSize.offset}px` : null}
              bind:this={sheetEl}
              bind:clientWidth={sheetW}
              bind:clientHeight={sheetH}
              onpointerdown={sheetDown}
              onpointermove={sheetMove}
              onclick={sheetClick}
            >
              <!-- Rendered by Verovio and sanitised in verovio-render.ts. -->
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html previewSvg}
              <!-- The staff numbers, drawn over the rendering's left margin;
                   they take no clicks. -->
              {#each staffMarks as y, i (i)}
                <span
                  class="staffmark"
                  class:lit={!!lit && i + 1 >= lit.start && i + 1 <= lit.end}
                  style:top="{y}px"
                  aria-hidden="true">{i + 1}</span
                >
              {/each}
            </div>
          {:else}
            <p class="muted">Rendering…</p>
          {/if}
        </section>
      </div>
      <DraftBubble {session} />
    </div>

    <!-- The setup form, in the side panel's Setup tab. -->
    {#snippet setupForm()}
      {#if !holds}
        <!-- The submitted values as text, for what the rendering leaves
             open: the transposition, an octave clef, which label belongs to
             a staff or a group. -->
        <div class="summary">
          <dl class="sumrest">
            <dt>Key signature</dt>
            <dd>
              {KEY_SIGNATURES.find((k) => k.value === keysig)?.label ?? keysig}
            </dd>
            <dt>Time signature</dt>
            <dd>
              {#if meterType === "numeric"}
                {meterCount}/{meterUnit}
              {:else}
                <MusicGlyph name={meterType} />
                {METER_NAMES[meterType]}
              {/if}
            </dd>
          </dl>
          <section>
            <p class="grouphead">Staves</p>
            <!-- The groups drawn beside the staves they join, an outer group
               nearer the staves than the groups inside it. -->
            <div
              class="sumstaffs"
              style:grid-template-columns={`repeat(${groupColumns}, 12px) minmax(0, 1fr)`}
              style:grid-template-rows={`repeat(${staves.length}, auto)`}
            >
              {#each ordered as group (group)}
                <span
                  class="summark"
                  class:bracket={group.symbol !== "brace"}
                  class:pointed={hoveredGroup === group}
                  style:grid-row={`${group.start} / ${group.end + 1}`}
                  style:grid-column={groupColumns - groupDepth(groups, group)}
                  aria-hidden="true"
                  >{#if group.symbol === "brace"}<MusicGlyph
                      name="brace"
                      stretch
                    />{/if}</span
                >
              {/each}
              <ol class="sumstaves">
                {#each staves as staff, i (i)}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                  <li
                    class:pointed={pointedStaff === i}
                    class:pickable={reviewAsking}
                    onmouseenter={() => (hoveredStaff = i)}
                    onmouseleave={() => (hoveredStaff = null)}
                    onclick={() => pickStaff(i)}
                  >
                    <span class="staffno">{i + 1}</span>
                    <span class="sumbody">
                      <span class="sumname" class:unnamed={!staff.label}
                        >{staff.label || "No instrument name"}</span
                      >
                      <span class="summeta">
                        <span class="clefname"
                          >{#if clefGlyph(staff)}<MusicGlyph
                              name={clefGlyph(staff)!}
                            />{/if}
                          {clefText(staff)}</span
                        >
                        {#if transposes(staff)}
                          <span>{transText(staff)}</span>
                        {/if}
                        {#if !unpitched(staff) && staffKeysig(keysig, staff) !== keysig}
                          <span
                            >Key: {keysigText(staffKeysig(keysig, staff))}</span
                          >
                        {/if}
                      </span>
                    </span>
                  </li>
                {/each}
              </ol>
            </div>
          </section>
          {#if groups.length}
            <section>
              <p class="grouphead">Groups</p>
              <ul class="sumgroups">
                {#each ordered as group (group)}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                  <li
                    class:inner={groupDepth(groups, group) > 0}
                    class:pointed={hoveredGroup === group}
                    class:pickable={reviewAsking}
                    onmouseenter={() => (hoveredGroup = group)}
                    onmouseleave={() => (hoveredGroup = null)}
                    onclick={() => pickGroup(group)}
                  >
                    <span class="sumname"
                      ><MusicGlyph name={symbolGlyph(group.symbol)} />
                      {symbolName(group.symbol)}</span
                    >
                    <span class="summeta">{groupText(group)}</span>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>
      {:else}
        <form class="setup" class:docked onsubmit={(e) => e.preventDefault()}>
          {#if docked}{@render steps()}{/if}
          {#if setupStep === 1}
            <fieldset disabled={!canEdit} class="sec-meter">
              <p class="grouphead">Key and time signature</p>
              <div class="meterrow">
                <label class="mfield">
                  <span>Key signature</span>
                  <select
                    class="ctl"
                    bind:value={keysig}
                    title="The accidentals the score opens with, on the staves that do not transpose."
                  >
                    {#each KEY_SIGNATURES as key (key.value)}
                      <option value={key.value}>{key.label}</option>
                    {/each}
                  </select>
                </label>
                <div class="mfield">
                  <span>Time signature</span>
                  <GlyphSelect
                    class="ctl"
                    options={METER_KINDS}
                    value={meterType}
                    onchange={(v) => (meterType = v as typeof meterType)}
                    label="Time signature"
                    title="Numbers (beats over a beat unit), or a symbol: common time or cut time."
                  />
                </div>
              </div>
              {#if meterType === "numeric"}
                <div class="meterrow">
                  <label class="mfield">
                    <span>Beats</span>
                    <input
                      class="ctl"
                      type="text"
                      inputmode="numeric"
                      bind:value={meterCount}
                      class:bad={!meterValid}
                      title="The number of beats in a bar — the upper number of the time signature."
                    />
                  </label>
                  <label class="mfield">
                    <span>Beat unit</span>
                    <select
                      class="ctl"
                      bind:value={meterUnit}
                      title="The note value that counts as one beat — the lower number of the time signature."
                    >
                      {#each METER_UNITS as unit (unit)}
                        <option value={String(unit)}>{unit}</option>
                      {/each}
                    </select>
                  </label>
                </div>
              {/if}
            </fieldset>

            <fieldset disabled={!canEdit} class="sec-staves">
              <p class="grouphead">Staves</p>
              <ol class="staves" bind:this={staffList}>
                {#each staves as staff, i (i)}
                  <li
                    class="staffrow"
                    class:transposing={!unpitched(staff) && transposes(staff)}
                    class:pointed={pointedStaff === i}
                    class:dragged={dragging === i && picked === null}
                    class:picked={picked === i}
                    {...pointAt(i)}
                  >
                    {#if canEdit && staves.length > 1}
                      <button
                        type="button"
                        class="staffgrip"
                        class:target={picked !== null && picked !== i}
                        style:grid-row="2 / span {transValue(staff) ===
                          'other' && !unpitched(staff)
                          ? 2
                          : 1}"
                        aria-label={`Staff ${i + 1}: move`}
                        aria-pressed={picked === i}
                        title={handleTitle(i)}
                        onpointerdown={(e) => handleDown(i, e)}
                        onpointermove={handleMove}
                        onpointerup={handleUp}
                        onpointercancel={handleUp}
                        onclick={() => handleClick(i)}
                        onkeydown={(e) => handleKey(i, e)}
                      >
                        <Icon name="grip" />
                      </button>
                    {/if}
                    <span class="staffno">{i + 1}</span>
                    <div class="staffline">
                      <input
                        class="ctl grow"
                        type="text"
                        bind:value={staff.label}
                        oninput={() => fillFromLabel(staff)}
                        placeholder="Instrument"
                        aria-label={`Staff ${i + 1}: instrument`}
                        title="The instrument or voice name printed in front of this staff. Leave empty for none. A name with a pitch, like Clarinetto in B, sets the transposition."
                      />
                      {#if canEdit}
                        <button
                          type="button"
                          class="btn btn-icon btn-danger"
                          onclick={() => removeStaff(i)}
                          disabled={staves.length <= 1 ||
                            (omr && data?.hasNotation)}
                          aria-label={`Remove staff ${i + 1}`}
                          title={omr && data?.hasNotation
                            ? "The staff count is fixed once the piece holds notation"
                            : "Remove this staff"}><Icon name="trash" /></button
                        >
                      {/if}
                    </div>
                    <div class="staffline">
                      <GlyphSelect
                        class="ctl clef"
                        options={clefOption(staff)
                          ? CLEF_OPTIONS
                          : [
                              {
                                value: "",
                                label: clefText(staff),
                                glyph: clefGlyph(staff),
                              },
                              ...CLEF_OPTIONS,
                            ]}
                        top={COMMON_CLEFS}
                        value={clefOption(staff)?.value ?? ""}
                        onchange={(v) => setClef(staff, v)}
                        label={`Staff ${i + 1}: clef`}
                        title="The clef this staff opens with."
                      />
                      {#if unpitched(staff) && staff.notationType !== "tab.lute.german"}
                        <select
                          class="ctl lines"
                          value={String(staff.lines)}
                          onchange={(e) => {
                            staff.lines = Number(
                              (e.target as HTMLSelectElement).value,
                            );
                            // Keep the clef on the staff: centred on the lines
                            // it actually has.
                            staff.clefLine = Math.ceil(staff.lines / 2);
                          }}
                          aria-label={`Staff ${i + 1}: lines`}
                          title="How many lines the staff has — one per string for a tablature, up to five for percussion."
                        >
                          {#each linesChoices(staff) as count (count)}
                            <option value={String(count)}
                              >{count} line{count === 1 ? "" : "s"}</option
                            >
                          {/each}
                        </select>
                      {:else if !unpitched(staff)}
                        <select
                          class="ctl trans"
                          value={transValue(staff)}
                          onchange={(e) =>
                            pickTransposition(
                              staff,
                              (e.target as HTMLSelectElement).value,
                            )}
                          aria-label={`Staff ${i + 1}: transposition`}
                          title={transposes(staff)
                            ? `Sounds ${soundsText(transOf(staff))} than written.`
                            : "Whether the instrument transposes: its music is written at another pitch than it sounds."}
                        >
                          <option value="none">Not transposing</option>
                          {#each COMMON_TRANSPOSITIONS as t, n (n)}
                            <option value={String(n)}>{t.label}</option>
                          {/each}
                          <option value="other">Other…</option>
                        </select>
                        <select
                          class="ctl key"
                          value={staff.keysig ?? ""}
                          onchange={(e) => {
                            const v = (e.target as HTMLSelectElement).value;
                            if (v === "") delete staff.keysig;
                            else staff.keysig = v;
                            settleKey(staff);
                          }}
                          aria-label={`Staff ${i + 1}: key signature`}
                          title={staff.keysig === undefined
                            ? transposes(staff)
                              ? "The key signature of this staff: the score's, moved by the transposition."
                              : "The key signature of this staff: the score's."
                            : "The key signature of this staff, chosen for it alone."}
                        >
                          <optgroup
                            label={transposes(staff)
                              ? "Score key, transposed"
                              : "Score key"}
                          >
                            <option value=""
                              >{keysigText(followedKey(staff))}</option
                            >
                          </optgroup>
                          <optgroup label="This staff only">
                            {#each STAFF_KEYS as k (k.value)}
                              <option value={k.value}>{k.label}</option>
                            {/each}
                          </optgroup>
                        </select>
                      {/if}
                    </div>
                    {#if transValue(staff) === "other" && !unpitched(staff)}
                      {@const c = customOf(staff)}
                      <div class="staffline custom">
                        <select
                          class="ctl"
                          value={c.pitch}
                          onchange={(e) =>
                            setCustom(staff, {
                              pitch: (e.target as HTMLSelectElement).value,
                            })}
                          aria-label={`Staff ${i + 1}: instrument pitch`}
                          title="The pitch the instrument is in: the note that sounds when a C is written."
                        >
                          {#each PITCHES as p (p.name)}
                            <option value={p.name}>in {p.name}</option>
                          {/each}
                        </select>
                        <select
                          class="ctl"
                          value={c.higher ? "higher" : "lower"}
                          onchange={(e) =>
                            setCustom(staff, {
                              higher:
                                (e.target as HTMLSelectElement).value ===
                                "higher",
                            })}
                          aria-label={`Staff ${i + 1}: sounds higher or lower`}
                          title="Whether the instrument sounds higher or lower than written."
                        >
                          <option value="lower">sounds lower</option>
                          <option value="higher">sounds higher</option>
                        </select>
                        <select
                          class="ctl"
                          value={String(c.octaves)}
                          onchange={(e) =>
                            setCustom(staff, {
                              octaves: Number(
                                (e.target as HTMLSelectElement).value,
                              ),
                            })}
                          aria-label={`Staff ${i + 1}: added octaves`}
                          title="Whole octaves added to the interval, as for a bass clarinet."
                        >
                          <option value="0">no octave</option>
                          <option value="1">+1 octave</option>
                          <option value="2">+2 octaves</option>
                        </select>
                      </div>
                    {/if}
                  </li>
                {/each}
              </ol>
              {#if canEdit}
                <button
                  type="button"
                  class="btn addbtn"
                  onclick={() => addStaff()}
                  disabled={staves.length >= MAX_STAVES ||
                    (omr && data?.hasNotation)}
                  title={omr && data?.hasNotation
                    ? "The staff count is fixed once the piece holds notation"
                    : "Add a staff below the last one."}>Add staff</button
                >
              {/if}
            </fieldset>
          {:else}
            <fieldset disabled={!canEdit} class="sec-groups">
              <p class="grouphead">Groups</p>
              <p class="vh" aria-live="polite">{liveText}</p>
              <!-- The marking in the preview: the first staff, the last, the
                   symbol. Docked and closed, the sheet shows this line or the
                   open group. -->
              {#if markable && !(compact && openG && markFrom === null)}
                <div class="markline">
                  {#if markFrom === null}
                    <p class="markhint">
                      {tapWord} the first staff of a group in the preview.
                    </p>
                  {:else if markTo === null}
                    <p class="markhint">
                      <strong>Staff {markFrom + 1}</strong> · {tapWord.toLowerCase()}
                      the last staff of the group.
                    </p>
                    <div class="markbtns">
                      {#each containing(markFrom + 1) as g (g)}
                        <button
                          type="button"
                          class="btn"
                          onclick={() => toggleRow(g)}
                          title="Open this group"
                          ><MusicGlyph
                            name={symbolGlyph(g.symbol)}
                          />{symbolName(g.symbol)}
                          {g.start}–{g.end}</button
                        >
                      {/each}
                      <button type="button" class="btn" onclick={clearMark}
                        >Cancel</button
                      >
                    </div>
                  {:else if markSpan}
                    <p class="markhint">
                      <strong>Staves {markSpan.start}–{markSpan.end}</strong>
                    </p>
                    {#if markProblem}
                      <p class="groupwarn">{markProblem}</p>
                    {/if}
                    <div class="markbtns">
                      {#if sameGroup}
                        <button
                          type="button"
                          class="btn"
                          onclick={() => toggleRow(sameGroup)}
                          title="Open this group"
                          ><MusicGlyph
                            name={symbolGlyph(sameGroup.symbol)}
                          />{symbolName(sameGroup.symbol)}
                          {sameGroup.start}–{sameGroup.end}</button
                        >
                      {:else if !markProblem}
                        <button
                          type="button"
                          class="btn"
                          onclick={() => addMarked("brace")}
                          title="Join the staves with a brace: the staves of one instrument, like a piano, or of a pair, like Horn 1 and 2."
                          ><MusicGlyph name="brace" />Brace</button
                        >
                        <button
                          type="button"
                          class="btn"
                          onclick={() => addMarked("bracket")}
                          title="Join the staves with a bracket: a section, like the woodwinds or the strings."
                          ><MusicGlyph name="bracket" />Bracket</button
                        >
                      {/if}
                      <button type="button" class="btn" onclick={clearMark}
                        >Cancel</button
                      >
                    </div>
                  {/if}
                </div>
              {/if}
              {#if compact}
                {#if openG && markFrom === null}{@render groupRow(openG)}{/if}
              {:else}
                <ul class="glist">
                  {#each ordered as g (g)}
                    <li>{@render groupRow(g)}</li>
                  {:else}
                    <li class="muted">No groups.</li>
                  {/each}
                </ul>
                {#if canEdit && freePair !== null}
                  <button
                    type="button"
                    class="btn addbtn"
                    onclick={() => addGroup()}
                    title="Join two neighbouring staves with a brace. Its staves and symbol can be changed below."
                    >Add group</button
                  >
                {/if}
              {/if}
              {#if !groupsValid}
                <p class="groupwarn">
                  Groups must fit the staves and must contain whole groups.
                </p>
              {/if}
            </fieldset>
          {/if}
        </form>
      {/if}
    {/snippet}

    <!-- A group: its line (symbol, staves, label), opening its values. -->
    {#snippet groupRow(g: StaffGroupModel)}
      <div
        class="gitem"
        class:open={openG === g}
        class:inner={groupDepth(groups, g) > 0}
        role="group"
        aria-label={`${symbolName(g.symbol)}, staves ${g.start} to ${g.end}`}
        onmouseenter={() => (hoveredGroup = g)}
        onmouseleave={() => (hoveredGroup = null)}
      >
        <button
          type="button"
          class="gline"
          aria-expanded={openG === g}
          onclick={() => toggleRow(g)}
          title={openG === g ? "Close this group" : "Open this group"}
        >
          <span class="gsym"
            ><MusicGlyph name={symbolGlyph(g.symbol)} />
            {symbolName(g.symbol)}</span
          >
          <span class="gstaves">{g.start}–{g.end}</span>
          <span class="glabel">{g.label.trim()}</span>
        </button>
        {#if openG === g}
          <div class="gfields">
            <div class="gfirst">
              <div class="field">
                <span>Symbol</span>
                <GlyphSelect
                  options={[
                    {
                      value: "brace",
                      label: "Brace",
                      glyph: "brace",
                      disabled: !fitsWith(g, { symbol: "brace" }),
                    },
                    { value: "bracket", label: "Bracket", glyph: "bracket" },
                  ]}
                  value={g.symbol}
                  onchange={(v) => (g.symbol = v)}
                  label="Symbol"
                  title="A brace joins the staves of one instrument, like a piano, or of a pair, like Horn 1 and 2. A bracket joins a section, like the strings."
                />
              </div>
              <label class="field narrow">
                <span>From staff</span>
                <select bind:value={g.start} title="The group's first staff.">
                  {#each staves as _, n (n)}
                    <option
                      value={n + 1}
                      disabled={!fitsWith(g, { start: n + 1 })}>{n + 1}</option
                    >
                  {/each}
                </select>
              </label>
              <label class="field narrow">
                <span>To staff</span>
                <select bind:value={g.end} title="The group's last staff.">
                  {#each staves as _, n (n)}
                    <option
                      value={n + 1}
                      disabled={!fitsWith(g, { end: n + 1 })}>{n + 1}</option
                    >
                  {/each}
                </select>
              </label>
              {#if canEdit}
                <button
                  type="button"
                  class="btn btn-icon btn-danger"
                  onclick={() => removeGroup(g)}
                  aria-label={`Remove the ${symbolName(g.symbol).toLowerCase()} over staves ${g.start}–${g.end}`}
                  title="Remove this group"><Icon name="trash" /></button
                >
              {/if}
            </div>
            <label class="field">
              <span>Label</span>
              <input
                type="text"
                bind:value={g.label}
                placeholder={canEdit ? "optional" : "—"}
                title="The name printed in front of the group, like Piano or Violini. Leave empty for none."
              />
            </label>
            <div class="gtoggles">
              <div class="mfield">
                <span id="gbar-{g.start}-{g.end}">Barlines</span>
                <div
                  class="seg gseg"
                  role="group"
                  aria-labelledby="gbar-{g.start}-{g.end}"
                  title="Whether the barlines run through the group's staves or stop at each staff, as on the page."
                >
                  <button
                    type="button"
                    class:on={g.barThru}
                    aria-pressed={g.barThru}
                    onclick={() => (g.barThru = true)}>Through</button
                  >
                  <button
                    type="button"
                    class:on={!g.barThru}
                    aria-pressed={!g.barThru}
                    onclick={() => (g.barThru = false)}>Per staff</button
                  >
                </div>
              </div>
              {#if g.symbol === "brace"}
                <div class="mfield">
                  <span id="ginstr-{g.start}-{g.end}">Staves</span>
                  <div
                    class="seg gseg"
                    role="group"
                    aria-labelledby="ginstr-{g.start}-{g.end}"
                    title="One instrument: one player's part over several staves, like a piano or a harp. Separate staves: one instrument per staff, like Horn 1 and 2. Set from the labels until chosen here."
                  >
                    <button
                      type="button"
                      class:on={g.oneInstrument}
                      aria-pressed={g.oneInstrument}
                      onclick={() => setOneInstrument(g, true)}
                      >One instrument</button
                    >
                    <button
                      type="button"
                      class:on={!g.oneInstrument}
                      aria-pressed={!g.oneInstrument}
                      onclick={() => setOneInstrument(g, false)}
                      >Separate staves</button
                    >
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/snippet}

    <!-- The setup's steps: in the task tools beside the content, at the top
         of the form in a docked sheet, where the tools give way to the form. -->
    {#snippet steps()}
      <div
        class="steps"
        role="group"
        aria-label="Steps"
        title="The two steps of the score setup."
      >
        {#each [{ step: 1, glyph: "staves", tone: "var(--ink-staff)", long: "Staves", count: `${staves.length}` }, { step: 2, glyph: "groups", tone: "var(--ink-grand)", long: "Groups", count: `${groups.length}` }] as st (st.step)}
          <button
            type="button"
            class="step"
            class:on={setupStep === st.step}
            aria-pressed={setupStep === st.step}
            onclick={() => goStep(st.step as 1 | 2)}
            aria-label={`${st.step} · ${st.long}, ${st.count}`}
            ><span class="stepno">{st.step}</span><StepGlyph
              kind={st.glyph as "staves" | "groups"}
              tone={st.tone}
            /><span class="steplong">{st.long}</span><span class="stepshort"
              >{st.long}</span
            ><span class="stepn">{st.count}</span><span class="stepcount"
              >{st.count}</span
            ></button
          >
        {/each}
      </div>
    {/snippet}

    <!-- The task tools: the setup's steps, and transcribing the staves
         again (an OMR-prepared piece). -->
    {#snippet tools()}
      {#if !docked}{@render steps()}{/if}
      {#if omr && canEdit && recognition && recognition.failed.length > 0}
        <button
          type="button"
          class="btn"
          onclick={() => recognise()}
          disabled={busy}
          title="Run the staff model again on the {recognition.failed
            .length} staves it could not transcribe"
        >
          Transcribe failed staves again
        </button>
      {:else if omr && canEdit && !recognition && recognisedFor === taskId}
        <button
          type="button"
          class="btn"
          onclick={() => recognise()}
          disabled={busy}
          title="Transcribe the staves again; staves already transcribed in this browser are kept"
        >
          Transcribe the staves again
        </button>
      {/if}
    {/snippet}

    <!-- The task's action at the panel's bottom. -->
    {#snippet footer()}
      <div class="wfoot">
        <span class="abcount wsum">
          {staves.length} stave{staves.length === 1 ? "" : "s"}
          · {meterType === "numeric"
            ? `${meterCount}/${meterUnit}`
            : meterType === "common"
              ? "common time"
              : "cut time"}
        </span>
        <span class="wstatus">
          <PreTaskStatus {session} />
        </span>
        {#if setupStep === 1}
          <button
            type="button"
            class="btn btn-secondary"
            onclick={() => goStep(2)}
            title="Go on to step 2: the braces and brackets that join staves. Submission is in step 2."
          >
            Next: groups
          </button>
        {:else}
          <button
            type="button"
            class="btn btn-primary btn-pre"
            onclick={() => submit()}
            disabled={busy ||
              !canEdit ||
              !meterValid ||
              !groupsValid ||
              (omr && !recognition)}
            title={omr && canEdit && !recognition
              ? "The staves have to be transcribed before the setup can be submitted"
              : "Submit the staves, clefs, key signature and time signature for review"}
          >
            Submit setup
          </button>
        {/if}
      </div>
    {/snippet}

    <!-- The viewer's verdict and Give back task, at the panel's bottom. -->
    {#snippet reviewFooter()}
      {#if session.card && session.reviewSub !== undefined}
        <ReviewActions
          task={session.card.task}
          sub={session.reviewSub}
          runner={session.runner}
          prefill={reviewPrefill}
          measures={false}
          staffs
          {staffPick}
          bind:asking={reviewAsking}
          onvalidate={(sub, verdict, comment) =>
            session.validate(sub, verdict, comment)}
          onreviewedit={(sub, comment) => session.reviewEdit(sub, comment)}
          onabandon={(sub) => session.abandon(sub)}
        />
      {/if}
    {/snippet}

    <!-- The last command's result, in the task box. -->
    {#snippet resultNote()}
      <RunnerBanner {runner} bar collapsible />
    {/snippet}

    {#snippet taskBox(headAction: Snippet | undefined)}
      {#if session.card}
        <PreTaskBox
          {session}
          {campaign}
          card={session.card}
          tools={resultNote}
          {headAction}
          prefill={reviewPrefill}
          measures={false}
        />
      {/if}
    {/snippet}

    {#if tables}
      <TaskPageSidePanel
        {tables}
        {taskId}
        done={data?.status === "completed"}
        {viewer}
        {runner}
        bind:panel={sidePanel}
        minWidth={session.reviewSub !== undefined
          ? PANEL_MIN_REVIEW
          : undefined}
        {taskBox}
        tools={canEdit ? tools : undefined}
        selection={setupForm}
        selectionLabel="Setup"
        selectionActive={canEdit}
        bind:tab={panelTab}
        bind:open={sheetOpen}
        footer={data.status === "encoding_required"
          ? footer
          : session.reviewSub !== undefined
            ? reviewFooter
            : undefined}
        onanchor={showAnchorFor}
        oncomment={(...args) => session.postComment(...args)}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}
  {/if}
</div>

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }

  /* The whole tool: the form and its preview on the desk, with the comments
     panel — carrying the task box — beside it. The app's navigation bar and
     footer come from the layout, as on every other page. */
  .corrector {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--desk);
    box-shadow: var(--shadow-inset);
  }
  /* The side panel brings no outer spacing of its own; the score view's
     host row provides it there. Docked below the tool it spans the width. */
  .corrector > :global(.spwrap:not(.docked)) {
    margin: 12px 16px 4px 0;
  }
  .deskwrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1.25rem 2rem;
    box-sizing: border-box;
  }
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* The source's first measure on the left, the preview of the setup
     beside it, both at the work area's full height, the divider (.pane-grip
     in ui.css) between them. */
  .desk {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 12px 16px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .facscol {
    flex-grow: 0;
    flex-shrink: 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* The page lies on the inset ground of the score viewer's panes
     (ScorePreview.svelte), which shows where the view reaches past it. */
  .facsbox {
    flex: 1;
    min-height: 0;
    display: flex;
    border-radius: 10px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    overflow: hidden;
  }
  @media (orientation: portrait) and (max-width: 1100px) {
    .desk {
      padding: 8px;
    }
  }
  /* Banner styles are shared app-wide in ui.css. */

  /* ------------------------------------------------------------------- form */
  /* The form in the side panel: the step's sections. */
  .setup {
    display: flex;
    flex-direction: column;
    gap: 12px;
    container-type: inline-size;
  }
  /* Docked, the 32px buttons take a 44px press through an invisible
     ::after. */
  .setup.docked .field select,
  .setup.docked .field input,
  .setup.docked .ctl,
  .setup.docked :global(.gsel) {
    min-height: 32px;
  }
  .setup.docked :global(.btn) {
    position: relative;
  }
  .setup.docked :global(.btn)::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
  /* The step's sections share the panel's paper, a hairline between them
     running to its edges. */
  .setup fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .setup fieldset + fieldset {
    margin-inline: -16px;
    padding: 14px 16px 0;
    border-top: 1px solid var(--line);
  }
  .grouphead {
    margin: 0 0 10px;
    font-size: 13.5px;
    font-weight: 600;
  }
  /* The marking in the preview: what to do next, then its buttons. */
  .markline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }
  .markhint {
    margin: 0;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .markhint strong {
    font-weight: 600;
    color: var(--ink);
  }
  .markbtns {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .markline > .groupwarn {
    margin: 0;
  }
  /* The groups, one line each in staff order, an inner group indented
     under the group holding it; the open one shows its values below. */
  .glist {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .gitem {
    border-radius: 8px;
    background: var(--bg-tint);
  }
  .gitem.inner {
    margin-left: 16px;
  }
  .gitem.open {
    background: var(--accent-tint-strong);
  }
  .gline {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    min-height: 32px;
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
    text-align: left;
    color: var(--ink);
    background: none;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  .gline:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .gsym {
    font-weight: 600;
  }
  .gstaves {
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .glabel {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-soft);
  }
  .gfields {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 2px 10px 10px;
  }
  .gfirst {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .gfirst > .field.narrow {
    width: 72px;
  }
  .gtoggles {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .gseg {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
  }
  .gseg > button {
    justify-content: center;
  }
  .groupwarn {
    margin: 8px 0 0;
    font-size: 12.5px;
    color: var(--danger);
  }
  .staves {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  /* A staff, as a row under a hairline: its number beside the instrument
     with the row's buttons, the clef, transposition and key below it, and
     the pitch fields of an unlisted transposition below that. */
  .staffrow {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    column-gap: 6px;
    row-gap: 6px;
    padding: 10px 2px 10px 6px;
    border-radius: 8px;
  }
  .staffrow + .staffrow {
    border-top: 1px solid var(--line);
    border-radius: 0;
  }
  .staffrow > .staffno {
    grid-column: 1;
    grid-row: 1;
    align-self: center;
    width: auto;
    text-align: center;
  }
  .staffrow > .staffline {
    grid-column: 2;
  }
  .staffrow > .staffline + .staffline {
    gap: 4px;
  }
  /* A transposing instrument's staff, in a tint of its own. */
  .staffrow.transposing {
    background: var(--pre-wash);
  }
  .staffrow.pointed {
    background: var(--accent-tint-strong);
  }
  /* The grab bar: a pill of dots under the staff's number, centred on the
     lines below the first (its row span is set per staff), with a press
     area of 24 by 40px around it. */
  .staffgrip {
    grid-column: 1;
    justify-self: center;
    align-self: center;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--line) 55%, transparent);
    color: var(--ink-soft);
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .staffgrip::after {
    content: "";
    position: absolute;
    inset: -6px -6px;
  }
  .staffgrip :global(svg) {
    width: 12px;
    height: 18px;
  }
  .staffgrip:active {
    cursor: grabbing;
  }
  @media (hover: hover) {
    .staffgrip:hover {
      color: var(--ink);
      background: var(--line);
    }
  }
  .staffgrip.target {
    cursor: pointer;
  }
  .staffrow.dragged {
    background: var(--accent-tint-strong);
    box-shadow: 0 2px 8px rgba(31, 36, 51, 0.14);
  }
  .staffrow.picked {
    background: var(--accent-tint-strong);
    outline: 1.5px solid var(--accent);
  }
  .staffline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .staffline > .ctl,
  .staffline > :global(.gsel) {
    flex: 1 1 0;
    min-width: 0;
  }
  .staffline > :global(.gsel.clef) {
    flex: 0 1 96px;
  }
  .staffline > .ctl.key {
    flex: 0 0 68px;
  }
  /* The staff blocks take the section's width up to a narrow margin. */
  .setup fieldset.sec-staves {
    padding-inline: 8px;
  }
  .staffline.custom > .ctl:first-child {
    flex: 0 0 72px;
  }
  /* Docked, the text is larger: the transposition takes its own line below
     the clef and key. */
  .setup.docked .staffline + .staffline {
    flex-wrap: wrap;
  }
  .setup.docked .staffline > :global(.gsel.clef) {
    flex: 1 1 0;
  }
  .setup.docked .staffline > .ctl.key {
    flex: 1 1 0;
  }
  .setup.docked .staffline > .ctl.trans {
    order: 1;
    flex-basis: 100%;
  }
  .staffline > .ctl.lines {
    flex: 0 0 96px;
  }
  .staffno {
    flex: none;
    width: 22px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  /* The glyph select takes the look of the shared compact control (.ctl). */
  .setup :global(.gsel) {
    font: inherit;
    font-size: 13px;
    box-sizing: border-box;
    height: 32px;
    padding: 4px 8px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
    text-overflow: ellipsis;
  }
  .setup :global(.gsel:disabled) {
    color: var(--ink-faint);
    background: var(--bg-tint);
    cursor: not-allowed;
  }

  /* ---------------------------------------------------------------- summary
     The submitted setup as text, for the reviewer and everyone not holding
     the task. */
  .summary {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* The staff rows, with a 12px column per level of groups before them;
     a group's mark spans its staves' rows. */
  .sumstaffs {
    display: grid;
    column-gap: 2px;
    row-gap: 6px;
  }
  .sumstaves {
    grid-column: -2;
    grid-row: 1 / -1;
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-rows: subgrid;
  }
  .summark {
    width: 8px;
    margin: 6px 0 6px 4px;
    color: var(--line-input);
  }
  .summark.bracket {
    width: 5px;
    margin-left: 5px;
    border: solid currentColor;
    border-width: 1.5px 0 1.5px 2px;
  }
  .summark.pointed {
    color: var(--accent);
  }
  .sumstaves > li {
    display: flex;
    gap: 6px;
    padding: 8px 8px 8px 4px;
    border-radius: 8px;
    background: var(--bg-tint);
  }
  .sumstaves > li.pointed {
    background: var(--accent-tint-strong);
  }
  .sumstaves .staffno {
    width: 16px;
    text-align: right;
  }
  .sumbody {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .sumname {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
  }
  .sumname.unnamed {
    font-weight: 400;
    color: var(--ink-faint);
  }
  .summeta {
    display: flex;
    flex-wrap: wrap;
    column-gap: 10px;
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .sumrest {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 12px;
    margin: 0;
    font-size: 12.5px;
  }
  .sumrest dt {
    font-weight: 600;
    color: var(--ink-faint);
  }
  .sumrest dd {
    margin: 0;
    color: var(--ink);
  }
  .sumgroups {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* While a change request is being written, a staff or group in the
     summary is clicked to name it in the request. */
  .sumstaves > li.pickable,
  .sumgroups > li.pickable {
    cursor: pointer;
  }
  .sumgroups > li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-radius: 8px;
    background: var(--bg-tint);
  }
  .sumgroups > li.inner {
    margin-left: 16px;
  }
  .sumgroups > li.pointed {
    background: var(--accent-tint-strong);
  }
  /* Key and time signature: two controls to a row, labelled like the
     group rows, set like the staff rows. */
  .meterrow {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .meterrow + .meterrow {
    margin-top: 8px;
  }
  .mfield {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .mfield > span {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .mfield > .ctl.bad {
    border-color: var(--danger-line);
  }
  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field.narrow {
    flex: none;
    width: 88px;
  }
  .field span {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .field select,
  .field input {
    font: inherit;
    font-size: 13px;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
  }
  .field select:disabled,
  .field input:disabled {
    color: var(--ink-faint);
    background: var(--bg-tint);
    cursor: not-allowed;
  }
  .rowbtns {
    flex: none;
    display: flex;
    gap: 4px;
  }
  .addbtn {
    align-self: flex-start;
  }
  /* The preview column: a sheet at the column's full size with the
     rendered setup at the width the script computes (--w), its first staff
     level with the source's (--offset). Until measured, the rendering takes
     the column's width, scaled down to its height. */
  .previewbox {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }
  .sheet {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    background: var(--facsimile-paper);
    border: 1px solid var(--line-input);
    box-shadow: var(--shadow-paper);
    padding: 8px 8px 8px 28px;
    overflow: hidden;
  }
  /* A staff's number in the sheet's left gutter, on the paper's white in
     both themes. */
  .staffmark {
    position: absolute;
    left: 0;
    width: 24px;
    transform: translateY(-50%);
    font: 600 11px var(--font);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-align: right;
    color: #666d83;
    pointer-events: none;
  }
  .staffmark.lit {
    color: #1b66c7;
  }
  .sheet > :global(svg) {
    display: block;
    flex: none;
    align-self: flex-start;
    width: var(--w, 100%);
    height: auto;
    max-height: 100%;
    margin-top: var(--offset, 0);
  }
  .sheet.sized > :global(svg) {
    max-height: none;
  }
  /* Step 2: the staves take clicks and taps, the preview scrolling when
     they need more than its height. */
  .sheet.picking {
    cursor: pointer;
  }
  .sheet.marking {
    overflow-y: auto;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  /* The staves a row of the form points at, and the marked ones. */
  .sheet :global(g.staff.pointed),
  .sheet :global(g.staff.pointed *) {
    fill: #1b66c7;
    stroke: #1b66c7;
  }

  /* ------------------------------------------------------------ side panel
     The footer action (SidePanel.svelte). */
  .wfoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* The setup's summary is a line of its own above the buttons. */
  .wsum {
    flex-basis: 100%;
  }
  .wstatus {
    flex: 1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }
  @media (orientation: portrait) and (max-width: 1100px) {
    .wfoot :global(.btn) {
      position: relative;
    }
    .wfoot :global(.btn)::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }
  .abcount {
    font-size: 12.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
