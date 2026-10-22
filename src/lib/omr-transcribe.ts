// Transcribing staves with the Musibot staff pipeline: crop each staff box
// out of the page image (browser canvas), upload the crops to one ephemeral
// page, run the pipeline once over all of them and collect the MusicXML each
// staff produced. A staff the pipeline fails on yields null, not an error: one
// failed staff must not fail a page.

import type { MeasureBox } from "./mei-facsimile.ts";
import type { OmrClient, OmrPipeline } from "./omr-client.ts";

// The crops go to the staff model as JPEGs, like the pipeline's own crops.
const CROP_JPEG_QUALITY = 0.95;

/** Cut the given rectangles (page pixels, see staffCrops) out of a page image. Browser only. */
export async function cropStaves(
  image: Blob,
  crops: MeasureBox[],
): Promise<Blob[]> {
  const bitmap = await createImageBitmap(image);
  try {
    const out: Blob[] = [];
    for (const crop of crops) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(crop.lrx - crop.ulx));
      canvas.height = Math.max(1, Math.round(crop.lry - crop.uly));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable.");
      ctx.drawImage(
        bitmap,
        crop.ulx,
        crop.uly,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      out.push(
        await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (blob) =>
              blob
                ? resolve(blob)
                : reject(new Error("Could not encode a staff crop.")),
            "image/jpeg",
            CROP_JPEG_QUALITY,
          ),
        ),
      );
    }
    return out;
  } finally {
    bitmap.close();
  }
}

const cropPath = (k: number) => `Staves/${k + 1}/image.jpg`;
const resultPath = (k: number) => `Staves/${k + 1}/transcription.musicxml`;

/**
 * Run the staff pipeline once over all crops, on one page, and return each
 * staff's MusicXML in crop order; null where the pipeline wrote nothing. The
 * pipeline writes no file for a staff it failed on, and the execution fails
 * only when every staff failed.
 */
export async function transcribeStaves(
  client: OmrClient,
  pipeline: OmrPipeline,
  crops: Blob[],
): Promise<(string | null)[]> {
  if (!crops.length) return [];
  return client.withPage(async (pageId) => {
    await client.upload(
      pageId,
      Object.fromEntries(crops.map((crop, k) => [cropPath(k), crop])),
    );
    const execution = await client.run(
      pageId,
      pipeline,
      crops.map((_, k) => cropPath(k)),
    );
    if (execution.state !== "completed") return crops.map(() => null);
    const written = new Set(await client.files(pageId));
    const files = await client.download(
      pageId,
      crops.map((_, k) => resultPath(k)).filter((path) => written.has(path)),
    );
    return Promise.all(
      crops.map(async (_, k) => {
        const file = files[resultPath(k)];
        return file ? file.text() : null;
      }),
    );
  });
}
