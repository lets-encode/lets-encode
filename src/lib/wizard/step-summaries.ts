/**
 * The one-line summaries the wizard's step navigation shows under completed
 * steps, built from what each step collected.
 */
import { licenseById } from "../licenses.ts";
import type { WizardStepId } from "../wizard.svelte.ts";

/** The parts of the wizard state the summaries read. */
export interface SummarySource {
  handle: string;
  title: string;
  license: string;
  files: readonly { name: string }[];
  iiifManifestUrl: string;
  candidates: readonly unknown[];
  encodings: readonly unknown[];
  images: readonly unknown[];
  repo: unknown;
  source: { title: string; publisher: string; date: string };
}

/** What the upload step collected: PDFs, other files, a manifest, pages. */
export function uploadSummary(w: SummarySource): string {
  const parts: string[] = [];
  const pdfs = w.files.filter((f) => /\.pdf$/i.test(f.name)).length;
  const others = w.files.length - pdfs;
  if (pdfs) parts.push(`${pdfs} PDF${pdfs === 1 ? "" : "s"}`);
  if (others) parts.push(`${others} file${others === 1 ? "" : "s"}`);
  if (w.iiifManifestUrl.trim()) parts.push("IIIF manifest");
  if (w.candidates.length) parts.push(`${w.candidates.length} pages`);
  else if (!parts.length && w.encodings.length)
    parts.push(
      `${w.encodings.length} encoding${w.encodings.length === 1 ? "" : "s"}`,
    );
  return parts.join(" · ") || "no material";
}

/** The source's title, then its publisher and date. */
export function sourceSummary(source: SummarySource["source"]): string {
  const imprint = [source.publisher, source.date].filter(Boolean).join(", ");
  return [source.title, imprint].filter(Boolean).join(" · ");
}

/** Every step's summary; `pieces` is the pieces step's own summary. */
export function stepSummaries(
  w: SummarySource,
  pieces: string,
): Record<WizardStepId, string> {
  return {
    name: [w.handle, w.title].filter((s) => s.trim()).join(" · "),
    license: licenseById(w.license).name.split(" — ")[0],
    upload: uploadSummary(w),
    pages: w.images.length
      ? `${w.images.length} kept`
      : w.repo
        ? "no pages"
        : "",
    source: sourceSummary(w.source),
    pieces,
    preparation: "",
  };
}
