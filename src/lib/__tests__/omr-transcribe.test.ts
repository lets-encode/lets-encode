import { test } from "node:test";
import assert from "node:assert/strict";

import { transcribeStaves } from "../omr-transcribe.ts";
import type { OmrClient, OmrExecution } from "../omr-client.ts";

const pipeline = { name: "mzk-staff", version: "1" };

const execution = (
  input: string[],
  state: string,
  error: string | null = null,
): OmrExecution => ({
  execution_id: 1,
  pipeline_name: "mzk-staff",
  pipeline_version: "1",
  input,
  state,
  error,
});

/** A client whose one execution ends in `state` and writes the transcriptions of `written` (1-based staves). */
function fakeClient(state: string, written: number[]) {
  const calls: string[] = [];
  const client = {
    async withPage<T>(work: (pageId: string) => Promise<T>) {
      calls.push("create");
      try {
        return await work("p1");
      } finally {
        calls.push("delete");
      }
    },
    async upload(pageId: string, files: Record<string, Blob>) {
      calls.push(`upload ${pageId} ${Object.keys(files).join(",")}`);
    },
    async run(
      _pageId: string,
      _pipeline: unknown,
      input: string[],
    ): Promise<OmrExecution> {
      calls.push(`run ${input.join(",")}`);
      return execution(input, state, state === "failed" ? "all failed" : null);
    },
    async files() {
      calls.push("files");
      return written.flatMap((n) => [
        `Staves/${n}/image.jpg`,
        `Staves/${n}/transcription.musicxml`,
      ]);
    },
    async download(_pageId: string, paths: string[]) {
      calls.push(`download ${paths.join(",")}`);
      return Object.fromEntries(
        paths.map((path) => [path, new Blob([`<xml>${path}</xml>`])]),
      );
    },
  } as unknown as OmrClient;
  return { client, calls };
}

const crops = (n: number) => Array.from({ length: n }, () => new Blob(["x"]));

test("transcribeStaves: one page, one execution over every crop, null for a staff without a transcription", async () => {
  const { client, calls } = fakeClient("completed", [1, 3]);
  const xmls = await transcribeStaves(client, pipeline, crops(3));
  assert.deepEqual(xmls, [
    "<xml>Staves/1/transcription.musicxml</xml>",
    null,
    "<xml>Staves/3/transcription.musicxml</xml>",
  ]);
  assert.deepEqual(calls, [
    "create",
    "upload p1 Staves/1/image.jpg,Staves/2/image.jpg,Staves/3/image.jpg",
    "run Staves/1/image.jpg,Staves/2/image.jpg,Staves/3/image.jpg",
    "files",
    "download Staves/1/transcription.musicxml,Staves/3/transcription.musicxml",
    "delete",
  ]);
});

test("transcribeStaves: a failed execution (every staff failed) yields null for every staff", async () => {
  const { client, calls } = fakeClient("failed", []);
  assert.deepEqual(await transcribeStaves(client, pipeline, crops(2)), [
    null,
    null,
  ]);
  assert.deepEqual(calls, [
    "create",
    "upload p1 Staves/1/image.jpg,Staves/2/image.jpg",
    "run Staves/1/image.jpg,Staves/2/image.jpg",
    "delete",
  ]);
});

test("transcribeStaves: results stay in crop order", async () => {
  const { client } = fakeClient(
    "completed",
    Array.from({ length: 40 }, (_, k) => 40 - k),
  );
  assert.deepEqual(
    await transcribeStaves(client, pipeline, crops(40)),
    crops(40).map(
      (_, k) => `<xml>Staves/${k + 1}/transcription.musicxml</xml>`,
    ),
  );
});

test("transcribeStaves: no crops, no page", async () => {
  const client = {
    withPage: async () => {
      throw new Error("should not be called");
    },
  } as unknown as OmrClient;
  assert.deepEqual(await transcribeStaves(client, pipeline, []), []);
});
