// Shared state for the campaign onboarding wizard. The wizard spans several
// screens but is one flow: a step index plus the values collected so far live
// here, so a step can read what earlier steps gathered without prop-threading.
//
// Everything is held in the browser until the final step, which creates the
// campaign repository and commits the campaign into it. `repo` records the
// repository once that step has created it, so a retry reuses it.
//
// What is collected is also mirrored into the browser's storage as a draft, so a
// setup that is interrupted can be continued; see wizard-draft.ts.

import type { Preparation } from "./campaign-init.ts";
import type {
  EncodingSource,
  PageCandidate,
  PageImage,
} from "./prepare-images.ts";
import { emptySourceMetadata, type SourceMetadata } from "./source-metadata.ts";
import type { Piece } from "./pieces.ts";
import { DEFAULT_LICENSE } from "./licenses.ts";
import {
  DRAFT_VERSION,
  discardDraft,
  readDraft,
  writeDraft,
  type DraftEntries,
  type WizardDraft,
} from "./wizard-draft.ts";
import { readDraftImages, storeDraftImages } from "./draft-images.ts";

/** The wizard's steps, in order. Drives navigation and the progress header. */
export const WIZARD_STEPS = [
  { id: "name", label: "Name" },
  { id: "license", label: "Licence" },
  { id: "upload", label: "Upload" },
  { id: "pages", label: "Pages" },
  { id: "source", label: "Source" },
  { id: "pieces", label: "Pieces" },
  { id: "preparation", label: "Preparation" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/** Character limit on the campaign description. */
export const MAX_DESCRIPTION_LENGTH = 300;

/**
 * The campaign's name, held in the slug registry from the name step onwards. It
 * is the single source of the name: the repository is created under it and it is
 * registered under the same value, so the repo name and the slug cannot diverge.
 */
export interface WizardClaim {
  name: string;
  /** The right to register this name, or to give it back. */
  token: string;
  /** When the hold runs out (ISO time); absent in drafts stored before. */
  expiresAt?: string;
  /** The name is registered to the campaign's repository. */
  registered?: boolean;
}

/** A page the upload offers, with whether the pages step keeps it. */
export interface PageChoice extends PageCandidate {
  include: boolean;
}

/** The campaign repository, once the final step has created it. */
export interface WizardRepo {
  owner: string;
  name: string;
  full_name: string;
  html_url: string;
  id: number;
}

/**
 * What the organiser confirms before their upload is committed. Versioned so a
 * campaign can record which wording was agreed to.
 */
export const COPYRIGHT_ACKNOWLEDGEMENT = {
  version: "1",
  text: "I have the right to publish these materials, and/or they are in the public domain.",
} as const;

export const wizard = $state<{
  step: WizardStepId;
  /**
   * The campaign's name: repo name, registry slug and address at once. Editable
   * until the name step holds it in the registry, after which `claim` carries it
   * and this only mirrors it.
   */
  handle: string;
  /** The held name, from the name step until the campaign is registered. */
  claim: WizardClaim | null;
  /** Human-readable label for the campaign. */
  title: string;
  /** Short statement of what the campaign sets out to encode. Optional. */
  description: string;
  /** SPDX id of the licence the encoding is published under. */
  license: string;
  /** Page images, PDFs and encodings picked in the upload step. */
  files: File[];
  /** A IIIF Presentation manifest whose canvases are fetched and committed. */
  iiifManifestUrl: string;
  copyrightAccepted: boolean;
  /**
   * Every page the upload offers, in the order they are to be committed, with
   * which of them the pages step keeps. A source is usually larger than the part
   * of it a campaign encodes, so this holds previews only — the pages kept are
   * fetched at committing size by the pages step.
   */
  candidates: PageChoice[];
  /**
   * What `candidates` was prepared from, so returning to the upload step and
   * continuing again does not read a long source a second time.
   */
  uploadKey: string;
  repo: WizardRepo | null;
  /**
   * The page images the pages step prepared at committing size, kept with
   * their bytes: later steps display them, the final step commits them, and a
   * PDF's rendered pages exist nowhere else once that step has run.
   */
  images: PageImage[];
  /** The candidate each of `images` was prepared from, by id, in page order. */
  imageCandidates: string[];
  /**
   * Uploaded encodings, converted to MEI. Held in the browser until the final
   * step, which writes them at their piece paths alongside config and tables.
   */
  encodings: EncodingSource[];
  /** Whole-source metadata, copied into each piece's header at the end. */
  source: SourceMetadata;
  /** The works within the source; one MEI and one task group each. */
  pieces: Piece[];
  /** The `uploadKey` the pieces were set up for; '' for none. */
  piecesUpload: string;
  /** The pieces were set up again because the upload changed. */
  piecesRedone: boolean;
  /**
   * How the facsimile pieces are prepared: measure boxes detected when the
   * campaign is finished, or staff and measure boxes recognised in each
   * piece's layout task with encoding starting from a transcription.
   */
  preparation: Preparation;
  /**
   * The preparation was chosen by hand in its step; until then the step
   * chooses it from the uploaded encodings.
   */
  preparationPicked: boolean;
}>({
  step: "name",
  handle: "",
  claim: null,
  title: "",
  description: "",
  license: DEFAULT_LICENSE,
  files: [],
  iiifManifestUrl: "",
  copyrightAccepted: false,
  candidates: [],
  uploadKey: "",
  repo: null,
  images: [],
  imageCandidates: [],
  encodings: [],
  source: emptySourceMetadata(),
  pieces: [],
  piecesUpload: "",
  piecesRedone: false,
  preparation: "measure-detection",
  preparationPicked: false,
});

export const stepIndex = (id: WizardStepId) =>
  WIZARD_STEPS.findIndex((s) => s.id === id);

/**
 * Whether a step has nothing to do for this campaign, so navigation and the
 * step rail pass over it. The pages step exists to choose between page images;
 * an upload that offers none has nothing to choose. The preparation step
 * decides how facsimile pieces get their measures; without page images —
 * prepared, or still to be chosen on the pages step ahead — there are none,
 * and the pieces step finishes the setup.
 */
export const isSkipped = (id: WizardStepId): boolean =>
  (id === "pages" && wizard.candidates.length === 0) ||
  (id === "preparation" &&
    wizard.images.length === 0 &&
    (wizard.candidates.length === 0 ||
      stepIndex(wizard.step) > stepIndex("pages")));

/**
 * "N pieces · M pages uncovered": the pieces and, with page images, how many
 * pages no piece has a region on yet.
 */
export function piecesSummary(): string {
  const count = `${wizard.pieces.length} piece${wizard.pieces.length === 1 ? "" : "s"}`;
  if (!wizard.images.length) return count;
  const marked = new Set(
    wizard.pieces.flatMap((p) => p.zones.map((z) => z.surface)),
  );
  const open = wizard.images.filter((_, i) => !marked.has(i)).length;
  return `${count} · ${open ? `${open} page${open === 1 ? "" : "s"} uncovered` : "all pages covered"}`;
}

/** Open a step; every move between steps goes through here. */
export function goToStep(id: WizardStepId): void {
  wizard.step = id;
  draftStatus.resumeNotice = null;
}

/** Advance to the next step (passing over steps with nothing to do), if there is one. */
export function nextStep(): void {
  for (let i = stepIndex(wizard.step) + 1; i < WIZARD_STEPS.length; i++) {
    if (isSkipped(WIZARD_STEPS[i].id)) continue;
    goToStep(WIZARD_STEPS[i].id);
    break;
  }
}

/** Return to the previous step (passing over steps with nothing to do), if there is one. */
export function previousStep(): void {
  for (let i = stepIndex(wizard.step) - 1; i >= 0; i--) {
    if (isSkipped(WIZARD_STEPS[i].id)) continue;
    goToStep(WIZARD_STEPS[i].id);
    break;
  }
}

// Counts the setups put into the wizard: emptying it or continuing another
// setup starts a new one. A step's work that ends after that compares the
// count it started with, and leaves the new setup alone.
let setupCount = 0;
export const currentSetup = (): number => setupCount;

/** Discard everything collected and return to the first step. */
export function resetWizard(): void {
  setupCount++;
  savedHandle = null;
  storedHandle = null;
  resetDraftStatus();
  wizard.step = "name";
  wizard.handle = "";
  wizard.claim = null;
  wizard.title = "";
  wizard.description = "";
  wizard.license = DEFAULT_LICENSE;
  wizard.files = [];
  wizard.iiifManifestUrl = "";
  wizard.copyrightAccepted = false;
  wizard.candidates = [];
  wizard.uploadKey = "";
  wizard.repo = null;
  wizard.images = [];
  wizard.imageCandidates = [];
  wizard.encodings = [];
  wizard.source = emptySourceMetadata();
  wizard.pieces = [];
  wizard.piecesUpload = "";
  wizard.piecesRedone = false;
  wizard.preparation = "measure-detection";
  wizard.preparationPicked = false;
}

// ---------------------------------------------------------------------------
// Drafts: the wizard's entries mirrored into the browser, so an interrupted
// setup can be continued. See wizard-draft.ts for what a record holds.

/** Whether the setup's draft could be stored. Surfaced by the wizard frame. */
export const draftStatus = $state<{
  saveError: string | null;
  /** Why the page images could not be kept in the browser, if they could not. */
  imagesError: string | null;
  /** When the draft was last written, as epoch milliseconds. */
  savedAt: number | null;
  /** Why a continued setup opened where it did, when that needs saying. */
  resumeNotice: string | null;
}>({
  saveError: null,
  imagesError: null,
  savedAt: null,
  resumeNotice: null,
});

// A setup put into the wizard starts with no draft status of its own.
function resetDraftStatus(): void {
  draftStatus.saveError = null;
  draftStatus.imagesError = null;
  draftStatus.savedAt = null;
  draftStatus.resumeNotice = null;
}

// The name the draft was last stored under. A campaign renamed before its
// repository exists would otherwise leave its earlier draft behind; its page
// images move to the new name with it.
let savedHandle: string | null = null;
// The name of the record this tab last stored, or continued from.
let storedHandle: string | null = null;

/** Everything a draft record carries, apart from the account it belongs to. */
export interface DraftSnapshot {
  handle: string;
  claim: WizardClaim | null;
  repo: WizardRepo | null;
  entries: DraftEntries;
}

/**
 * A draft's contents, read out of the wizard state. Every stored field is read
 * here and nowhere else, so a caller collecting this inside a reactive effect
 * depends on all of them, and can write the result on a debounce.
 */
export function draftSnapshot(): DraftSnapshot {
  return {
    handle: wizard.handle,
    claim: wizard.claim ? { ...wizard.claim } : null,
    repo: wizard.repo ? { ...wizard.repo } : null,
    entries: {
      step: wizard.step,
      title: wizard.title,
      description: wizard.description,
      license: wizard.license,
      iiifManifestUrl: wizard.iiifManifestUrl,
      copyrightAccepted: wizard.copyrightAccepted,
      imagePaths: wizard.images.map((image) => image.path),
      imageSizes: wizard.images.map((image) => image.blob.size),
      imageCandidates: [...wizard.imageCandidates],
      piecesUpload: wizard.piecesUpload,
      encodings: wizard.encodings.map((encoding) => ({ ...encoding })),
      source: $state.snapshot(wizard.source),
      pieces: $state.snapshot(wizard.pieces),
      preparation: wizard.preparation,
      preparationPicked: wizard.preparationPicked,
    },
  };
}

/**
 * Store what has been entered, under the campaign's name. On the name step a
 * draft is stored under a name once it is reserved, so a draft always has a
 * name to be listed and continued under; without a reservation only the
 * record already stored under the same name is updated (the release of its
 * reservation), not one per name typed.
 */
export function saveDraft(owner: string, snapshot: DraftSnapshot): void {
  const name = snapshot.handle.trim();
  if (!owner || !name) return;
  if (
    snapshot.entries.step === "name" &&
    !snapshot.claim &&
    savedHandle !== name
  )
    return;
  // A record stored for this setup and gone since was finished or discarded
  // in another tab; it is not stored again.
  if (storedHandle === name && readDraft(owner, name) === null) {
    draftStatus.saveError = "it was finished or discarded in another tab";
    return;
  }
  if (savedHandle && savedHandle !== name) {
    discardDraft(owner, savedHandle);
    if (wizard.images.length) void keepDraftImages(owner, name);
  }
  savedHandle = name;
  draftStatus.saveError = writeDraft({
    version: DRAFT_VERSION,
    owner,
    handle: name,
    updatedAt: new Date().toISOString(),
    claim: snapshot.claim,
    repo: snapshot.repo,
    entries: snapshot.entries,
  });
  if (!draftStatus.saveError) {
    storedHandle = name;
    draftStatus.savedAt = Date.now();
  }
}

/**
 * Keep the wizard's page images in the browser under the campaign's name, so a
 * continued setup has them. A browser that refuses is reported through
 * draftStatus; the setup goes on without them.
 */
export async function keepDraftImages(
  owner: string,
  handle: string,
): Promise<void> {
  const name = handle.trim();
  if (!name) return;
  draftStatus.imagesError = await storeDraftImages(owner, name, wizard.images);
}

/**
 * Put a draft's entries back into the wizard and open the step it was left on.
 * The page images are passed in, read from the browser's image store.
 */
export function applyDraft(draft: WizardDraft, images: PageImage[]): void {
  const entries = draft.entries;
  if (!entries) return;
  setupCount++;
  wizard.handle = draft.handle;
  wizard.claim = draft.claim ?? null;
  wizard.title = entries.title;
  wizard.description = entries.description;
  wizard.license = entries.license;
  wizard.iiifManifestUrl = entries.iiifManifestUrl;
  wizard.copyrightAccepted = entries.copyrightAccepted;
  wizard.repo = draft.repo;
  // Fields added to SourceMetadata since a draft was stored default to empty.
  wizard.source = { ...emptySourceMetadata(), ...entries.source };
  wizard.pieces = entries.pieces.map((piece) => ({
    ...piece,
    meta: { ...emptySourceMetadata(), ...piece.meta },
  }));
  wizard.encodings = entries.encodings;
  wizard.preparation = entries.preparation;
  wizard.preparationPicked = entries.preparationPicked ?? false;
  wizard.imageCandidates = entries.imageCandidates ?? [];
  wizard.piecesUpload = entries.piecesUpload ?? "";
  wizard.piecesRedone = false;
  wizard.images = images;
  // Picked files are not part of a draft; the upload step collects them again.
  // The candidate pages read from them go the same way.
  wizard.files = [];
  wizard.candidates = [];
  wizard.uploadKey = "";
  savedHandle = draft.handle;
  storedHandle = draft.handle;
  resetDraftStatus();
  // Page images the draft records but that could not be read back: every step
  // after the upload works on them, so there is nothing to continue from until
  // they are uploaded again.
  const withoutImages = entries.imagePaths.length > 0 && images.length === 0;
  // Choosing pages needs the files they come from, so a setup left on that step
  // is continued from the upload step, where they are picked again.
  const step =
    entries.step === "pages" || withoutImages ? "upload" : entries.step;
  goToStep(stepIndex(step) < 0 ? "name" : step);
  // Opening a step clears the notice, so it is set once the step is open.
  draftStatus.resumeNotice = withoutImages
    ? "The page images of this setup are no longer stored in this browser. Please upload the images again."
    : null;
}

/**
 * Continue the setup stored under `handle`: read its record and its page images
 * from the browser, and put it into the wizard. The stored record decides what
 * is continued, not a listing read earlier, since the setup may have been
 * finished or discarded in another tab since. Throws with a message that names
 * what went wrong.
 */
export async function resumeDraft(
  owner: string,
  handle: string,
): Promise<void> {
  const stored = readDraft(owner, handle);
  if (!stored)
    throw new Error("it has since been finished or discarded in this browser");
  const paths = stored.entries.imagePaths;
  // Images that are not stored any more can be uploaded again: applyDraft puts
  // a setup without its images on the upload step.
  const images = paths.length
    ? ((await readDraftImages(
        owner,
        stored.handle,
        paths,
        stored.entries.imageSizes,
      )) ?? [])
    : [];
  applyDraft(stored, images);
}

/**
 * Clear a setup that has completed: its draft is dropped, since there is a
 * campaign now and nothing left to continue, and the wizard is emptied for the
 * next one. Emptying it is also what stops a later save from storing the finished
 * setup again — saveDraft keeps nothing without a name.
 */
export function clearFinishedSetup(owner: string): void {
  discardDraft(owner, wizard.handle.trim());
  resetWizard();
}
