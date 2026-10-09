// Small per-piece previews: the first facsimile page image (thumbnail) and a
// Verovio incipit — the opening system rendered as a narrow SVG strip.
//
// Browser-only — the incipit renders through a Verovio WASM toolkit. The
// incipit toolkit is separate from the score preview's shared toolkit
// (verovio-render.ts): a toolkit holds one loaded document, so sharing it with
// a mounted score preview would invalidate that preview's page indices.

import type { VerovioToolkit } from "verovio/esm";
import type { ForgeClient } from "./forge/types.ts";
import { parseFacsimileMei } from "./mei-facsimile.ts";
import type { MeasureBox } from "./mei-facsimile.ts";
import { resolveFacsimileImageUrls } from "./facsimile-images.ts";
import { renderPage } from "./verovio-render.ts";

export interface PagePreview {
  /** Download URL of the page image; '' = none reachable. */
  url: string;
  /** The surface's coordinate space, which the zones and the box use. */
  width: number;
  height: number;
  /** The box around the page's measure zones; null without zones. */
  box: MeasureBox | null;
  /** The box around the page's first system; null without zones. */
  system: MeasureBox | null;
}

export interface PiecePreview {
  /** Download URL of the first facsimile page image; '' = none reachable. */
  thumb: string;
  /** Each facsimile page; empty without a facsimile. */
  pages: PagePreview[];
  /** Sanitised SVG of the opening system; '' = nothing rendered. */
  incipit: string;
  /** True while the score has facsimile pages but no measures yet. */
  incipitPending: boolean;
  /** Measure count of each facsimile page; empty without a facsimile. */
  pageMeasures: number[];
  /** Staves in the score definition. */
  staves: number;
  /** True when loading the preview failed, as opposed to there being none. */
  failed: boolean;
}

const EMPTY: PiecePreview = {
  thumb: "",
  pages: [],
  incipit: "",
  incipitPending: false,
  pageMeasures: [],
  staves: 0,
  failed: false,
};

// One load per piece per page load; a failed load is dropped so the next
// mount retries it.
const cache = new Map<string, Promise<PiecePreview>>();

/**
 * The cached preview of one piece, loading it on first request. With
 * `incipit` false the incipit is not rendered (its field stays ''), which
 * spares loading the Verovio toolkit; a cached full preview still serves it.
 */
export function piecePreview(
  f: ForgeClient,
  owner: string,
  repo: string,
  path: string,
  incipit = true,
): Promise<PiecePreview> {
  const full = `${owner}/${repo}/${path}`;
  const key = incipit ? full : `${full}#thumb`;
  let loading = cache.get(full) ?? cache.get(key);
  if (!loading) {
    loading = loadPreview(f, owner, repo, path, incipit).catch(() => {
      cache.delete(key);
      return { ...EMPTY, failed: true };
    });
    cache.set(key, loading);
  }
  return loading;
}

async function loadPreview(
  f: ForgeClient,
  owner: string,
  repo: string,
  path: string,
  incipit: boolean,
): Promise<PiecePreview> {
  const mei = await f.getRepoFile(owner, repo, path);
  if (mei == null) return EMPTY;
  const parsed = parseFacsimileMei(mei);

  const urls = parsed.pages.length
    ? await resolveFacsimileImageUrls(
        f,
        owner,
        repo,
        path,
        parsed.pages.map((page) => page.image),
      )
    : [];
  const pages: PagePreview[] = parsed.pages.map((page, i) => {
    // The first system runs up to the next measure that starts a system.
    const next = page.zones.findIndex(
      (zone, j) => j > 0 && (zone.sb || zone.pb),
    );
    return {
      url: urls[i] ?? "",
      width: page.width,
      height: page.height,
      box: boxAround(page.zones),
      system: boxAround(next === -1 ? page.zones : page.zones.slice(0, next)),
    };
  });
  const thumb = pages.find((page) => page.url)?.url ?? "";

  const pageMeasures = parsed.pages.map((page) => page.zones.length);
  const staves = parsed.scoreDef.staves.length;

  // A facsimile score renders only once its measures exist; a score without
  // facsimile pages renders as-is.
  if (parsed.pages.length && !parsed.hasMeasures) {
    return {
      thumb,
      pages,
      incipit: "",
      incipitPending: true,
      pageMeasures,
      staves,
      failed: false,
    };
  }
  return {
    thumb,
    pages,
    incipit: incipit ? await renderIncipit(mei) : "",
    incipitPending: false,
    pageMeasures,
    staves,
    failed: false,
  };
}

/** The smallest box holding every zone; null without zones. */
function boxAround(zones: { box: MeasureBox }[]): MeasureBox | null {
  return zones.reduce<MeasureBox | null>(
    (box, zone) =>
      box
        ? {
            ulx: Math.min(box.ulx, zone.box.ulx),
            uly: Math.min(box.uly, zone.box.uly),
            lrx: Math.max(box.lrx, zone.box.lrx),
            lry: Math.max(box.lry, zone.box.lry),
          }
        : { ...zone.box },
    null,
  );
}

// ---------------------------------------------------------------------------
// Incipit rendering

// The tiny pageHeight makes Verovio put exactly one system on each page;
// adjustPageHeight then grows the SVG viewBox to that system's real extent.
const INCIPIT_OPTIONS = {
  pageWidth: 2400,
  pageHeight: 100,
  adjustPageHeight: true,
  scale: 40,
  header: "none",
  footer: "none",
  svgViewBox: true,
  breaks: "auto",
};

let toolkitLoading: Promise<VerovioToolkit> | null = null;

function getIncipitToolkit(): Promise<VerovioToolkit> {
  toolkitLoading ??= loadToolkit().catch((err) => {
    toolkitLoading = null;
    throw err;
  });
  return toolkitLoading;
}

async function loadToolkit(): Promise<VerovioToolkit> {
  const [{ default: createVerovioModule }, { VerovioToolkit }] =
    await Promise.all([import("verovio/wasm"), import("verovio/esm")]);
  const tk = new VerovioToolkit(await createVerovioModule());
  tk.setOptions(INCIPIT_OPTIONS);
  return tk;
}

// The toolkit holds one document at a time, so concurrent piece loads render
// one after another.
let queue: Promise<unknown> = Promise.resolve();

function renderIncipit(mei: string): Promise<string> {
  const job = async () => {
    const tk = await getIncipitToolkit();
    if (!tk.loadData(mei) || tk.getPageCount() < 1) return "";
    return renderPage(tk, 1);
  };
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}
