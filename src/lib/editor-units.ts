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
