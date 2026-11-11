// Transcription (pieces whose layout task names the instruments)
//
// While the claim holder is in the instruments step, every staff box is
// transcribed in the background (recognisePiece, without reading labels:
// the step reads them for the names). The record goes with the draft and
// the submission as `omr.xml`, which the page drafts are made from. A staff
// that the saved work's record, this session's record or this browser
// already holds for the same box is not transcribed again, so a later run
// transcribes only the boxes changed since. Submission waits for a record
// of the current boxes.

import { untrack } from "svelte";
import { forge } from "../auth.svelte.ts";
import type { FacsimileTaskData } from "../commands.ts";
import type { createOmrClient } from "../omr-client.ts";
import {
  recognisePiece,
  type PieceRecognition,
} from "../omr-piece-recognition.ts";
import { omrRecordPath, parseOmrRecord } from "../omr-record.ts";
import { omr as omrModels } from "../forge/config.ts";
import { toPageModels, type EditPage } from "./edit-pages.ts";

export interface StaffTranscriptionHost {
  omr(): boolean;
  /** The layout task names the instruments. */
  naming(): boolean;
  /** The instruments step is in view. */
  step4(): boolean;
  canEdit(): boolean;
  data(): FacsimileTaskData | null;
  pages(): EditPage[];
  owner(): string;
  repo(): string;
  repoId(): number;
  omrClient(): ReturnType<typeof createOmrClient>;
}

export class StaffTranscription {
  recognition = $state.raw<PieceRecognition | null>(null);
  recognisedKey = $state("");
  triedKey = $state("");
  runningKey = $state<string | null>(null);
  transcription = $state<{ text: string; error: boolean } | null>(null);
  #host: StaffTranscriptionHost;

  constructor(host: StaffTranscriptionHost) {
    this.#host = host;
    // A run starts once per set of boxes; after a failure, on request.
    $effect(() => {
      if (
        this.#host.step4() &&
        this.#host.canEdit() &&
        this.#host.data() &&
        this.runningKey === null &&
        this.staffKey !== this.recognisedKey &&
        this.staffKey !== this.triedKey
      )
        untrack(() => this.transcribe());
    });
  }

  // The staff boxes, page by page in order, as one string: the boxes the
  // record describes, those a run was last started for, and those of a run
  // in progress.
  staffKey = $derived.by(() =>
    this.#host.naming()
      ? JSON.stringify(
          this.#host
            .pages()
            .map((pg) =>
              pg.staves.map((s) => [
                s.box.ulx,
                s.box.uly,
                s.box.lrx,
                s.box.lry,
              ]),
            ),
        )
      : "",
  );

  async transcribe() {
    const f = forge();
    const d = this.#host.data();
    if (!f || !d || this.runningKey !== null) return;
    const key = this.staffKey;
    this.triedKey = key;
    this.runningKey = key;
    this.transcription = { text: "Starting the transcription", error: false };
    try {
      // A record saved with the work, or kept from an expired claim, comes
      // before the campaign's.
      const from = d.workSource ?? {
        owner: this.#host.owner(),
        repo: this.#host.repo(),
        ref: undefined,
      };
      const existing =
        this.recognition?.record ??
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
        client: this.#host.omrClient(),
        owner: this.#host.owner(),
        repo: this.#host.repo(),
        repoId: this.#host.repoId(),
        fragment: d.fragment,
        pages: toPageModels(this.#host.pages(), this.#host.omr()),
        existing,
        pipeline: omrModels.staffPipeline,
        progress: (step) => {
          this.transcription = { text: step, error: false };
        },
        readLabels: false,
      });
      this.recognition = result;
      this.recognisedKey = key;
      const total = result.record.pages.reduce(
        (n, pg) => n + pg.staves.length,
        0,
      );
      this.transcription = result.failed.length
        ? {
            text: `${result.failed.length} of ${total} staves could not be transcribed (${result.failed
              .map((s) => `page ${s.page}, staff ${s.staff}`)
              .join(
                "; ",
              )})${result.runErrors.length ? `; the staff pipeline reported: ${result.runErrors.join("; ")}` : ""}.`,
            error: true,
          }
        : { text: `All ${total} staves are transcribed.`, error: false };
    } catch (e) {
      this.transcription = {
        text: `The transcription failed: ${(e as Error).message}`,
        error: true,
      };
    } finally {
      this.runningKey = null;
    }
  }
}
