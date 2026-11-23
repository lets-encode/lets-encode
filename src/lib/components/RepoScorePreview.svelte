<!--
  The score viewer (ScorePreview) for a score in a campaign repository: reads
  the file at `fragment`, or takes the score's text from the caller, resolves
  the addresses of its page images, and hands both to the viewer.
-->
<script lang="ts">
  import { untrack, type ComponentProps } from "svelte";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import type { UnitScore } from "$lib/editor-units.ts";
  import { resolveFacsimileImageUrls } from "$lib/facsimile-images.ts";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import ScorePreview from "./ScorePreview.svelte";

  let {
    owner,
    repo,
    fragment,
    mei = null,
    startPage = 0,
    ...rest
  }: Omit<ComponentProps<typeof ScorePreview>, "score" | "loadError"> & {
    owner: string;
    repo: string;
    /** Repo path of the score to show; changing it loads the other score. */
    fragment: string;
    /**
     * The score's text, shown in place of the file at `fragment`; the
     * facsimile images are still resolved relative to `fragment`.
     */
    mei?: string | null;
  } = $props();

  let score = $state.raw<UnitScore | null>(null);
  let loadError = $state<string | null>(null);
  // The start page of the load in front, as it was when the load began.
  let from = $state(0);
  // Each load's number; a load finishing after a later one started is dropped.
  let loads = 0;

  async function load(path: string, text: string | null, page: number) {
    const f = readForge();
    const n = ++loads;
    // New text for the score already shown replaces it once it is ready.
    if (text === null || score?.name !== path) {
      score = null;
      loadError = null;
      from = page;
    }
    try {
      const document = text ?? (await f.getRepoFile(owner, repo, path));
      if (document == null) throw new Error(`Could not read ${path}.`);
      const pages = await resolveFacsimileImageUrls(
        f,
        owner,
        repo,
        path,
        parseFacsimileMei(document).pages.map((page) => page.image),
      );
      if (n === loads) {
        loadError = null;
        score = { name: path, document, pages };
      }
    } catch (e) {
      if (n === loads) {
        score = null;
        loadError = (e as Error).message;
      }
    }
  }

  $effect(() => {
    const path = fragment;
    const text = mei;
    untrack(() => load(path, text, startPage));
  });

  let preview = $state<ReturnType<typeof ScorePreview>>();

  export function pageOfMeasure(
    ...args: Parameters<ReturnType<typeof ScorePreview>["pageOfMeasure"]>
  ) {
    return preview?.pageOfMeasure(...args) ?? -1;
  }
  export function showPage(page: number) {
    preview?.showPage(page);
  }
  export function currentPage(): number {
    return preview?.currentPage() ?? 0;
  }
  export function canStepMeasure(dir: 1 | -1): boolean {
    return preview?.canStepMeasure(dir) ?? false;
  }
  export function stepMeasure(dir: 1 | -1) {
    preview?.stepMeasure(dir);
  }
  export function clearSelection() {
    preview?.clearSelection();
  }
  export function setZones(on: boolean) {
    preview?.setZones(on);
  }
</script>

<ScorePreview
  bind:this={preview}
  {score}
  {loadError}
  startPage={from}
  {...rest}
/>
