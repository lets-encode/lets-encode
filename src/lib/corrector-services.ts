// The network work of the measure and layout correction and of the score
// setup for a task of a campaign repository: page images through the forge API, the layout model and the
// staff transcription through the broker's relay, the detected layouts kept
// in this browser per task.

import type { FacsimileTaskData } from "./commands.ts";
import { resolveRepoRelativeTarget } from "./facsimile-images.ts";
import { omr as omrModels } from "./forge/config.ts";
import type { ForgeClient } from "./forge/types.ts";
import type { createOmrClient } from "./omr-client.ts";
import { LAYOUT_PARAMETERS, type CocoLayout } from "./omr-layout.ts";
import {
  clearCachedLayouts,
  readCachedLayouts,
  writeCachedLayout,
} from "./omr-layout-cache.ts";
import type { PageModel } from "./mei-facsimile.ts";
import {
  recognisePiece,
  type PieceRecognition,
} from "./omr-piece-recognition.ts";
import { omrRecordPath, parseOmrRecord, type OmrRecord } from "./omr-record.ts";
import type { SetupServices } from "./setup/host.ts";
import type { CorrectorServices } from "./zones/host.ts";

export interface CorrectorServicesOptions {
  forge: ForgeClient;
  /** The loaded task. */
  data: Pick<FacsimileTaskData, "fragment" | "workSource">;
  owner: string;
  repo: string;
  repoId: number;
  taskId: string;
  omrClient(): ReturnType<typeof createOmrClient>;
}

/**
 * Transcribe the staves of `pages`, reading their labels with `readLabels`.
 * `known` is the record of this session; without one, the record saved with
 * the work, or kept from an expired claim, comes before the campaign's.
 */
export async function recogniseStaves(
  o: Omit<CorrectorServicesOptions, "taskId">,
  pages: PageModel[],
  known: OmrRecord | null,
  progress: (step: string) => void,
  readLabels: boolean,
): Promise<PieceRecognition> {
  const from = o.data.workSource ?? {
    owner: o.owner,
    repo: o.repo,
    ref: undefined,
  };
  const existing =
    known ??
    parseOmrRecord(
      await o.forge.getRepoFile(
        from.owner,
        from.repo,
        omrRecordPath(o.data.fragment),
        from.ref,
      ),
    );
  return recognisePiece({
    forge: o.forge,
    client: o.omrClient(),
    owner: o.owner,
    repo: o.repo,
    repoId: o.repoId,
    fragment: o.data.fragment,
    pages,
    existing,
    pipeline: omrModels.staffPipeline,
    progress,
    readLabels,
  });
}

export function correctorServices(
  o: CorrectorServicesOptions,
): CorrectorServices {
  const { forge: f, data } = o;
  const pageImage = async (image: string) => {
    const path = resolveRepoRelativeTarget(data.fragment, image);
    return path ? await f.getRepoFileBytes(o.owner, o.repo, path) : null;
  };
  return {
    keptLayouts: () =>
      readCachedLayouts(o.repoId, o.taskId, omrModels.layoutModel),
    forgetLayouts: () => clearCachedLayouts(o.repoId, o.taskId),
    checkLayoutService: () =>
      o.omrClient().requirePipelines([omrModels.layoutModel]),
    async detectLayout(p, target) {
      const client = o.omrClient();
      const image = await pageImage(target);
      if (!image)
        throw new Error(
          `the image of page ${p + 1} (${target}) could not be read.`,
        );
      const layout = await client.withPage(async (pageId) => {
        await client.upload(pageId, { "image.jpg": image });
        const execution = await client.run(
          pageId,
          omrModels.layoutModel,
          ["image.jpg"],
          LAYOUT_PARAMETERS,
        );
        if (execution.state !== "completed") {
          throw new Error(
            `the layout model failed on page ${p + 1}: ${execution.error ?? execution.state}.`,
          );
        }
        const files = await client.download(pageId, ["layout.json"]);
        return JSON.parse(await files["layout.json"].text()) as CocoLayout;
      });
      writeCachedLayout(
        o.repoId,
        o.taskId,
        omrModels.layoutModel,
        target,
        layout,
      );
      return layout;
    },
    transcribeStaves: (pages, known, progress) =>
      recogniseStaves(o, pages, known, progress, false),
    pageImage,
  };
}

export const setupServices = (
  o: Omit<CorrectorServicesOptions, "taskId">,
): SetupServices => ({
  recogniseStaves: (pages, known, progress) =>
    recogniseStaves(o, pages, known, progress, true),
});
