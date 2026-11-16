/**
 * Types shared by the editor units and the pages that host them. A unit is
 * given a document and reports a changed one; this module imports nothing.
 */

/** A measure range on a score page. */
export interface MeasureAnchor {
  page: number;
  m1: number;
  m2: number;
}

/** One score handed to a unit. */
export interface UnitScore {
  /**
   * Identifies the score, and names it in messages. A new document under
   * the same name is a new state of the same score.
   */
  name: string;
  /** The score's text (MEI). */
  document: string;
  /**
   * The address of each facsimile page's image, in the order of the
   * document's surfaces; "" for an image that cannot be reached.
   */
  pages: string[];
}

/** How long work of a unit ended. */
export interface WorkResult {
  ok?: boolean;
  /** An ok result of which part failed. */
  outcome?: "partial";
  error?: string;
  message?: string;
  /** Runs the failed work again. */
  retry?: () => void;
}

/** Long work as a unit's host shows it: one at a time, its steps and its result. */
export interface UnitWork {
  readonly busy: boolean;
  readonly log: {
    step(text: string): void;
    detail(text: string): void;
  };
  run(work: () => Promise<WorkResult>): Promise<unknown>;
}
