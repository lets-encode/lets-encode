// The score setup's submission and its draft: the definition, with the
// recognition record this session made (an OMR-prepared piece).

import { commands, invoke } from "../commands.ts";
import { serializeOmrRecord } from "../omr-record.ts";
import type { PreTaskSession } from "../pre-task-session.svelte.ts";
import { withClefCorrections } from "./clef-corrections.ts";
import type { SetupModel } from "./setup-model.svelte.ts";
import type { SetupRecognition } from "./setup-recognition.svelte.ts";

export class SetupSubmission {
  // True from Submit until the command has finished. The submission runs
  // without the overlay, so the button shows the check until the pull
  // request's pending entry takes over.
  submitting = $state(false);
  #session: PreTaskSession;
  #taskId: () => string;
  #model: SetupModel;
  #recognition: SetupRecognition;

  constructor(
    session: PreTaskSession,
    taskId: () => string,
    model: SetupModel,
    recognition: SetupRecognition,
  ) {
    this.#session = session;
    this.#taskId = taskId;
    this.#model = model;
    this.#recognition = recognition;
  }

  /** The recognition record with the clef corrections, as `omr.xml`. */
  #omr() {
    const recognition = this.#recognition;
    return recognition.omr && recognition.result
      ? {
          omr: serializeOmrRecord(
            withClefCorrections(
              this.#session.data?.model,
              this.#model.staves,
              recognition.result.record,
            ),
          ),
        }
      : {};
  }

  /** Run inside an `$effect`: while the task is held, its definition (and
      the recognition record this session made) is saved as a draft after
      each pause in editing. */
  saveDraft() {
    if (!this.#session.canEdit || this.#model.staves.length === 0) return;
    this.#session.draft({ scoreDef: this.#model.scoreDef, ...this.#omr() });
  }

  submit = async () => {
    this.submitting = true;
    try {
      await this.#session.run(
        (c) =>
          invoke(
            commands.submitScoreSetup,
            {
              task_id: this.#taskId(),
              scoreDef: this.#model.scoreDef,
              ...this.#omr(),
            },
            c,
          ),
        { overviewOnSuccess: true },
      );
    } finally {
      this.submitting = false;
    }
  };
}
