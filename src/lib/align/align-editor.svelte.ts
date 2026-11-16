// The encoding alignment as it is edited: the fixed links, the staves
// chosen and the file measure edits, the alignment computed from them, the
// measure selected on the score, and the changes to the file's measures.

import {
  fileEditsOf,
  pinsOf,
  scoreStavesOf,
  shiftPins,
  withoutAddedMeasure,
  type FileEdits,
  type FileSlot,
  type Pin,
} from "../encoding-align.ts";
import {
  alignEncoding,
  type AlignedEncoding,
  type EncodingInput,
} from "../encoding-merge.ts";
import { alignmentProblems } from "./problems.ts";

/** What is aligned: the campaign's score and the uploaded file. */
export type AlignSource = Pick<
  EncodingInput,
  "current" | "corrected" | "upload" | "preparation"
>;

/** The choices of an alignment, as its record and its draft keep them. */
export type AlignEdits = Pick<
  EncodingInput,
  "pins" | "scoreStaves" | "fileEdits"
>;

export interface AlignEditorHost {
  /** The scores to align; null while they are not loaded. */
  source(): AlignSource | null;
  canEdit(): boolean;
}

export class AlignEditor {
  // The fixed links, the score staves and the file measure edits chosen.
  pins = $state<Pin[]>([]);
  scoreStaves = $state<(number | null)[] | undefined>();
  fileEdits = $state<FileEdits>({ removed: [], added: [] });
  // The panel's step chosen: 1 the staves, 2 the measures; null before any.
  stepChoice = $state<1 | 2 | null>(null);
  // The measure selected on the score: a layout measure label and, where
  // the viewer knows it, its position among the layout measures.
  selectedMeasure = $state<string | null>(null);
  selectedAt = $state<number | null>(null);
  #host: AlignEditorHost;

  constructor(host: AlignEditorHost) {
    this.#host = host;
  }

  /** Take the choices of an alignment record (`alignment.json`). */
  load(record: string | null) {
    this.pins = pinsOf(record);
    this.scoreStaves = scoreStavesOf(record);
    this.fileEdits = fileEditsOf(record);
    this.stepChoice = null;
  }

  /** The choices as plain values. */
  edits(): AlignEdits {
    return {
      pins: $state.snapshot(this.pins),
      scoreStaves: $state.snapshot(this.scoreStaves),
      fileEdits: $state.snapshot(this.fileEdits),
    };
  }

  input = $derived.by((): EncodingInput | null => {
    const source = this.#host.source();
    return source ? { ...source, ...this.edits() } : null;
  });
  aligned = $derived.by((): AlignedEncoding | null =>
    this.input ? alignEncoding(this.input) : null,
  );

  // The file staves used, and whether the automatic map uses every file
  // staff in order: then, without staves chosen, the panel opens on the
  // measures.
  usedStaves = $derived(
    this.aligned?.scoreStaves.filter((s) => s !== null) ?? [],
  );
  step = $derived(
    this.stepChoice ??
      (this.scoreStaves === undefined &&
      this.aligned &&
      this.usedStaves.length === this.aligned.fileStaves.length &&
      this.usedStaves.every((s, i) => s === i + 1)
        ? 2
        : 1),
  );
  // The automatic score staves, for marking the reviewer's changed rows.
  automatic = $derived.by(() =>
    !this.#host.canEdit() &&
    this.step === 1 &&
    this.input &&
    this.scoreStaves !== undefined
      ? alignEncoding({ ...this.input, scoreStaves: undefined }).scoreStaves
      : null,
  );

  selectedBox = $derived.by(() => {
    const aligned = this.aligned;
    if (this.selectedMeasure === null || !aligned) return null;
    if (this.selectedAt !== null)
      return this.selectedAt < aligned.layout.length ? this.selectedAt : null;
    const i = aligned.layout.findIndex((m) => m.label === this.selectedMeasure);
    return i < 0 ? null : i;
  });
  selectedMatch = $derived(
    this.selectedBox === null
      ? null
      : (this.aligned?.alignment.matches[this.selectedBox] ?? null),
  );

  // The file measures some layout measure holds.
  held = $derived(
    new Set(
      (this.aligned?.alignment.matches ?? []).flatMap((s) =>
        s ? [s.measure] : [],
      ),
    ),
  );

  // The empty measures added to the file.
  addedIds = $derived(new Set(this.aligned?.fileAdded.map((a) => a.id)));

  /** A file measure's label, else its place in the file before the edits. */
  ownLabel = (id: string, label: string) =>
    label || String((this.aligned?.fileIds.indexOf(id) ?? 0) + 1);

  fileLabel = (slot: FileSlot): string => {
    const m = this.aligned?.file[slot.measure];
    if (!m) return "";
    const label = this.ownLabel(m.id, m.label);
    return m.span > 1 ? `${label}·${slot.part + 1}` : label;
  };

  /** Change the file measure edits; the fixed links stay on their measures. */
  editFile = (next: FileEdits) => {
    if (!this.aligned) return;
    this.pins = shiftPins(
      this.pins,
      this.aligned.fileIds,
      this.fileEdits,
      next,
    );
    this.fileEdits = next;
  };

  /** Remove file measure `i` (of the edited file) from the file. */
  removeFileMeasure = (i: number) => {
    const id = this.aligned?.file[i]?.id;
    if (!id) return;
    this.editFile(
      this.addedIds.has(id)
        ? withoutAddedMeasure(this.fileEdits, id)
        : {
            removed: [...this.fileEdits.removed, id],
            added: this.fileEdits.added,
          },
    );
  };

  // The changes to the file's measures, each with its undo.
  fileChanges = $derived.by(() => {
    const aligned = this.aligned;
    if (!aligned) return [];
    const { file, fileAdded, fileRemoved } = aligned;
    return [
      ...fileAdded.map((a) => {
        const k = file.findIndex((m) => m.id === a.id);
        const before = file
          .slice(0, k)
          .reverse()
          .find((m) => !this.addedIds.has(m.id));
        return {
          key: a.id,
          added: true,
          text: before
            ? `Empty measure added after file measure ${this.ownLabel(before.id, before.label)}`
            : "Empty measure added at the start",
          undo: () => this.editFile(withoutAddedMeasure(this.fileEdits, a.id)),
        };
      }),
      ...fileRemoved.map((r) => ({
        key: r.id,
        added: false,
        text: `File measure ${this.ownLabel(r.id, r.label)} removed`,
        undo: () =>
          this.editFile({
            removed: this.fileEdits.removed.filter((id) => id !== r.id),
            added: this.fileEdits.added,
          }),
      })),
    ];
  });

  problems = $derived(
    this.aligned ? alignmentProblems(this.aligned, this.held) : [],
  );

  // Whether the selected measure's file measure was chosen in the select.
  chosen = $derived(this.pins.some((pin) => pin.box === this.selectedBox));

  /** Fix the selected measure to `slot`, dropping the fixed links out of order with it. */
  fix = (slot: FileSlot | null) => {
    const box = this.selectedBox;
    if (box === null) return;
    this.pins = [
      ...this.pins.filter(
        (pin) =>
          pin.box !== box &&
          !(
            slot &&
            pin.slot &&
            (pin.box < box
              ? pin.slot.measure >= slot.measure
              : pin.slot.measure <= slot.measure)
          ),
      ),
      { box, slot },
    ];
  };

  /** Let the alignment choose the selected measure's file measure again. */
  placeAutomatically = () => {
    this.pins = this.pins.filter((pin) => pin.box !== this.selectedBox);
  };
}
