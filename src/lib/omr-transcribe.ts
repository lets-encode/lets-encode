// Transcribing staves with the Musibot staff pipeline: crop each staff box
// out of the page image (browser canvas), upload the crops to one ephemeral
// page, run the pipeline over them and collect the MusicXML each staff
// produced. A pipeline runs once over all crops; a model reads one staff per
// execution, so it runs once per crop. A staff the pipeline fails on yields
// null, not an error: one failed staff must not fail a page.

import type { MeasureBox } from "./mei-facsimile.ts";
import type { OmrClient, OmrExecution, OmrPipeline } from "./omr-client.ts";

// The crops go to the staff model as JPEGs, like the pipeline's own crops.
const CROP_JPEG_QUALITY = 0.95;

// Executions of a model that run at once; the broker relays at most four
// requests of one login at a time.
const MODEL_RUNS_AT_ONCE = 3;

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

/** Run `pipeline` once per path, MODEL_RUNS_AT_ONCE at a time, in path order. */
async function runEach(
  client: OmrClient,
  pageId: string,
  pipeline: OmrPipeline,
  paths: string[],
): Promise<OmrExecution[]> {
  const executions = new Array<OmrExecution>(paths.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    for (let i = next++; i < paths.length && !stopped; i = next++) {
      try {
        executions[i] = await client.run(pageId, pipeline, [paths[i]]);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };
  const workers = Math.min(MODEL_RUNS_AT_ONCE, paths.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return executions;
}

/**
 * Run the staff pipeline over all crops, on one page, and return each staff's
 * MusicXML in crop order; null where the pipeline wrote nothing. `perStaff`
 * runs it once per crop, as a model requires; otherwise once over all crops.
 * No file is written for a staff that failed; `error` is set only when every
 * execution failed, and is the first one's reason.
 */
export async function transcribeStaves(
  client: OmrClient,
  pipeline: OmrPipeline,
  crops: Blob[],
  perStaff = false,
): Promise<{ xmls: (string | null)[]; error: string | null }> {
  if (!crops.length) return { xmls: [], error: null };
  return client.withPage(async (pageId) => {
    await client.upload(
      pageId,
      Object.fromEntries(crops.map((crop, k) => [cropPath(k), crop])),
    );
    const paths = crops.map((_, k) => cropPath(k));
    const executions = perStaff
      ? await runEach(client, pageId, pipeline, paths)
      : [await client.run(pageId, pipeline, paths)];
    const failed = executions.filter((e) => e.state !== "completed");
    if (failed.length === executions.length)
      return {
        xmls: crops.map(() => null),
        error: failed[0].error ?? `the run ended as ${failed[0].state}`,
      };
    const written = new Set(await client.files(pageId));
    const files = await client.download(
      pageId,
      crops.map((_, k) => resultPath(k)).filter((path) => written.has(path)),
    );
    const xmls = await Promise.all(
      crops.map(async (_, k) => {
        const file = files[resultPath(k)];
        return file ? file.text() : null;
      }),
    );
    return { xmls, error: null };
  });
}
