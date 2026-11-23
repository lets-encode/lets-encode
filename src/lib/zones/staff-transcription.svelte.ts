// Transcription (pieces whose layout task names the instruments)
//
// While the claim holder is in the instruments step, every staff box is
// transcribed in the background by the host's services (without reading
// labels: the step reads them for the names). The record goes with the draft and
// the submission as `omr.xml`, which the page drafts are made from. A staff
// that the saved work's record, this session's record or this browser
// already holds for the same box is not transcribed again, so a later run
// transcribes only the boxes changed since. Submission waits for a record
// of the current boxes.

import { untrack } from "svelte";
import type { PieceRecognition } from "../omr-piece-recognition.ts";
import { toPageModels, type EditPage } from "./edit-pages.ts";
import type { CorrectorInput, CorrectorServices } from "./host.ts";

export interface StaffTranscriptionHost {
  omr(): boolean;
  /** The layout task names the instruments. */
  naming(): boolean;
  /** The instruments step is in view. */
  step4(): boolean;
  canEdit(): boolean;
  data(): CorrectorInput | null;
  pages(): EditPage[];
  /** The network work; null while it is not available. */
  services(): CorrectorServices | null;
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
    const services = this.#host.services();
    if (!services || !this.#host.data() || this.runningKey !== null) return;
    const key = this.staffKey;
    this.triedKey = key;
    this.runningKey = key;
    this.transcription = { text: "Starting the transcription", error: false };
    try {
      const result = await services.transcribeStaves(
        toPageModels(this.#host.pages(), this.#host.omr()),
        this.recognition?.record ?? null,
        (step) => {
          this.transcription = { text: step, error: false };
        },
      );
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
