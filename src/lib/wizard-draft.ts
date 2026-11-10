// Storage for a campaign setup in progress: the entries the onboarding wizard
// has collected are mirrored into localStorage under one record per account
// and campaign name, so a setup interrupted by a reload, a closed tab or a failed step can be
// continued from the campaign list.
//
// A record holds less than the wizard's state. `File` objects and image bytes
// cannot be stored in localStorage, so a draft keeps the repository-relative
// paths of the page images the pages step prepared, and their bytes are kept in
// IndexedDB (draft-images.ts) until the final step commits them; files that were
// picked but not yet read, and the candidate pages read from them, are not kept.
// Uploaded encodings are MEI text and are stored as they are, since nothing else
// holds them until the final step commits them.
//
// A record exists only while a setup is unfinished: once the last step has
// committed the campaign, the record is removed. So every record here describes
// something that can be continued.

import type { Preparation } from "./campaign-init.ts";
import type { EncodingSource } from "./prepare-images.ts";
import type { SourceMetadata } from "./source-metadata.ts";
import type { Piece } from "./pieces.ts";
import type { WizardClaim, WizardRepo, WizardStepId } from "./wizard.svelte.ts";
import { discardDraftImages, moveUnkeyedDraftImages } from "./draft-images.ts";
import {
  localKeys,
  readLocal,
  removeLocal,
  writeLocal,
} from "./local-store.ts";

/** Records written under any other version are ignored when read back. */
export const DRAFT_VERSION = 1;

const KEY_PREFIX = "lets-encode:setup:";

/** The wizard entries a draft carries over. */
export interface DraftEntries {
  /** The step the setup was left on. */
  step: WizardStepId;
  title: string;
  description: string;
  license: string;
  iiifManifestUrl: string;
  copyrightAccepted: boolean;
  /** Paths of the prepared page images, in page order; the bytes are in IndexedDB. */
  imagePaths: string[];
  /** The byte size of each of those images; absent in drafts stored before. */
  imageSizes?: number[];
  /** The candidate each image was prepared from; absent in drafts stored before. */
  imageCandidates?: string[];
  /** The upload the pieces were set up for; absent in drafts stored before. */
  piecesUpload?: string;
  encodings: EncodingSource[];
  source: SourceMetadata;
  pieces: Piece[];
  /** How facsimile pieces are prepared. */
  preparation: Preparation;
  /** The preparation was chosen by hand; absent in drafts stored before. */
  preparationPicked?: boolean;
}

export interface WizardDraft {
  version: number;
  /** Login of the account the setup was started on. */
  owner: string;
  /** The campaign's name, which is also this record's key. */
  handle: string;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  /**
   * The name held for this setup in the slug registry. Carried so a continued
   * setup can still register the name it holds, rather than having to ask for it
   * again and find it gone.
   */
  claim: WizardClaim | null;
  /** The campaign repository, once the final step has created it. */
  repo: WizardRepo | null;
  entries: DraftEntries;
}

const draftKey = (owner: string, handle: string) =>
  `${KEY_PREFIX}${owner}/${handle}`;

// The wizard's step ids, mirroring WIZARD_STEPS in wizard.svelte.ts (that
// module imports this one, so the list cannot be read from there).
const STEP_IDS: readonly WizardStepId[] = [
  "name",
  "license",
  "upload",
  "pages",
  "source",
  "pieces",
  "preparation",
];

/**
 * A record from its stored JSON, or null if it is absent, unreadable, of another
 * version, or missing the entries a setup needs to be continued.
 */
export function parseDraft(text: string | null): WizardDraft | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const draft = value as WizardDraft;
  if (draft.version !== DRAFT_VERSION) return null;
  if (typeof draft.handle !== "string" || !draft.handle) return null;
  if (typeof draft.owner !== "string") return null;
  const entries = draft.entries;
  if (!entries || typeof entries !== "object") return null;
  if (!STEP_IDS.includes(entries.step)) return null;
  if (typeof entries.title !== "string") return null;
  if (typeof entries.description !== "string") return null;
  if (typeof entries.license !== "string") return null;
  if (!Array.isArray(entries.imagePaths)) return null;
  if (!Array.isArray(entries.encodings)) return null;
  if (!Array.isArray(entries.pieces)) return null;
  if (!entries.source || typeof entries.source !== "object") return null;
  return draft;
}

/** The record `owner` stored for the setup named `handle`. */
export function readDraft(owner: string, handle: string): WizardDraft | null {
  return parseDraft(readLocal(draftKey(owner, handle)));
}

/**
 * Store a record. Returns the browser's message when it refused the write —
 * a storage quota is a few megabytes, and uploaded encodings count against it —
 * and null when the record was stored.
 */
export function writeDraft(draft: WizardDraft): string | null {
  return writeLocal(draftKey(draft.owner, draft.handle), JSON.stringify(draft));
}

export function discardDraft(owner: string, handle: string): void {
  removeLocal(draftKey(owner, handle));
  discardDraftImages(owner, handle);
}

/**
 * The setups `owner` can continue, most recently changed first. Records of other
 * accounts are left out: continuing a setup creates the repository on the
 * account that is signed in. `owner`'s records stored under the name alone
 * (before drafts were kept per account) are moved to the account's key, with
 * their page images.
 */
export function resumableDrafts(owner: string): WizardDraft[] {
  const drafts: WizardDraft[] = [];
  for (const key of localKeys(KEY_PREFIX)) {
    const draft = parseDraft(readLocal(key));
    if (!draft || draft.owner !== owner) continue;
    const ownKey = draftKey(owner, draft.handle);
    if (key === `${KEY_PREFIX}${draft.handle}`) {
      // A record already under the account's key is the newer one and is
      // listed on its own; a record that cannot be moved stays where it is.
      if (readLocal(ownKey) !== null) removeLocal(key);
      else if (writeDraft(draft) === null) {
        removeLocal(key);
        moveUnkeyedDraftImages(owner, draft.handle);
        drafts.push(draft);
      }
      continue;
    }
    if (key === ownKey) drafts.push(draft);
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
