// Text recognition (OCR) in the browser with tesseract.js, used to read the
// instrument labels printed in front of the staves: by the score setup, which
// fills the labels in, by the layout task's instrument naming, and by the OMR
// page drafts, which place the staves of a shorter system by them. Its worker
// and WASM core are bundled assets and its language data is served at /ocr/
// (vite.config.js), all from the app's own origin and loaded on first use
// only.

import { version as tesseractVersion } from "tesseract.js/package.json";
import type { MeasureBox } from "./mei-facsimile.ts";
import { OCR_DATA_DIR, OCR_LANGUAGES } from "./ocr-data.ts";

/** A word read, with its box in image pixels: left, top, right, bottom. */
interface OcrWord {
  text: string;
  box: [number, number, number, number];
}

/** The engine as a recognition record names it; `version` is the bundled tesseract.js release. */
export const OCR_ENGINE = {
  engine: "tesseract.js",
  version: tesseractVersion,
  language: OCR_LANGUAGES.join("+"),
};

/** The smallest part of a word's confidence kept; lower readings are noise. */
const MIN_WORD_CONF = 30;

async function createWorker() {
  const [tesseract, worker, core] = await Promise.all([
    import("tesseract.js"),
    import("tesseract.js/dist/worker.min.js?url"),
    import("tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url"),
  ]);
  // A failed start is reported through the error handler; createWorker's
  // promise does not settle then, so the failure is raced against it.
  let failed: (e: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => (failed = reject));
  return Promise.race([
    tesseract.createWorker(OCR_LANGUAGES, tesseract.OEM.LSTM_ONLY, {
      // The worker is started from its own URL rather than a blob, so the
      // page's script policy (same origin only) covers it.
      workerPath: worker.default,
      corePath: core.default,
      workerBlobURL: false,
      langPath: `/${OCR_DATA_DIR}`,
      errorHandler: (e: unknown) =>
        failed(new Error(`text recognition could not start (${String(e)}).`)),
    }),
    failure,
  ]);
}

/**
 * The label printed in front of each staff box of each system on a page
 * image: the words read in the margin left of the staves, enlarged, each
 * given to the staff of its system whose middle is nearest, within that
 * staff's height (a label between two braced staves goes to one of them). A
 * system's margin ends where its own staves begin, so a system indented
 * further than the others (an introduction) keeps the label in its indent.
 * A word outside every system's height, such as a page foot, right of its
 * system's margin, or without a letter is given to none. '' for a box with
 * no label.
 */
export async function readStaffLabels(
  image: Blob,
  systems: MeasureBox[][],
): Promise<string[][]> {
  const margins = systems.map((system) =>
    system.length ? Math.min(...system.map((box) => box.ulx)) - 2 : 0,
  );
  const right = Math.max(0, ...margins);
  if (right < 10) return systems.map((system) => system.map(() => ""));
  const bitmap = await createImageBitmap(image);
  const worker = await createWorker();
  try {
    // The margin, enlarged three times, read as sparse text (page
    // segmentation 11): scattered words rather than blocks.
    const scale = 3;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(right * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    ctx.drawImage(
      bitmap,
      0,
      0,
      right,
      bitmap.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    await worker.setParameters({ tessedit_pageseg_mode: "11" as never });
    const { data } = await worker.recognize(
      canvas,
      {},
      { blocks: true, text: false },
    );
    const read: OcrWord[] = (data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.flatMap((line) =>
          line.words
            .filter((w) => w.confidence >= MIN_WORD_CONF && w.text.trim())
            .map((w) => ({
              text: w.text.trim(),
              box: [
                Math.round(w.bbox.x0 / scale),
                Math.round(w.bbox.y0 / scale),
                Math.round(w.bbox.x1 / scale),
                Math.round(w.bbox.y1 / scale),
              ] as OcrWord["box"],
            })),
        ),
      ),
    );
    const words = systems.map((system) => system.map(() => [] as OcrWord[]));
    for (const word of read) {
      const middle = (word.box[1] + word.box[3]) / 2;
      const s = systems.findIndex(
        (system) =>
          system.length > 0 &&
          middle >= Math.min(...system.map((box) => box.uly)) &&
          middle <= Math.max(...system.map((box) => box.lry)),
      );
      // A word without a letter is a brace or bracket read as text.
      if (s < 0 || word.box[2] > margins[s] || !/\p{L}/u.test(word.text))
        continue;
      let best = -1;
      let distance = Infinity;
      systems[s].forEach((box, i) => {
        const d = Math.abs((box.uly + box.lry) / 2 - middle);
        if (d <= box.lry - box.uly && d < distance) {
          best = i;
          distance = d;
        }
      });
      if (best >= 0) words[s][best].push(word);
    }
    // A label may take two printed lines: its words in line order, left to
    // right within a line (a word starting below the middle of another is
    // on a later line).
    const byLine = (a: OcrWord, b: OcrWord) =>
      a.box[1] >= (b.box[1] + b.box[3]) / 2
        ? 1
        : b.box[1] >= (a.box[1] + a.box[3]) / 2
          ? -1
          : a.box[0] - b.box[0];
    return words.map((system) =>
      system.map((w) =>
        w
          .sort(byLine)
          .map((word) => word.text)
          .join(" "),
      ),
    );
  } finally {
    await worker.terminate();
    bitmap.close();
  }
}
