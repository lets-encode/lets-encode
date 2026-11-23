// The problems of an encoding alignment worth a look, each one line.

import { labelRanges } from "../encoding-align.ts";
import type { AlignedEncoding } from "../encoding-merge.ts";

export interface AlignmentProblem {
  text: string;
  title: string;
  /** The layout measures it concerns, highlighted when it is shown. */
  measures: number[];
}

const measuresWord = (list: number[]) =>
  list.length === 1 ? "Measure" : "Measures";

/** The problems of `aligned`; `held` are the file measures some layout measure holds. */
export function alignmentProblems(
  aligned: AlignedEncoding,
  held: Set<number>,
): AlignmentProblem[] {
  if (aligned.summary.kind === "different") return [];
  const { layout, file, alignment, staffMap, staffCount } = aligned;
  const out: AlignmentProblem[] = [];
  if (alignment.ambiguous.length)
    out.push({
      text: `${measuresWord(alignment.ambiguous)} ${labelRanges(layout, alignment.ambiguous)}: placement not certain`,
      title:
        "The repeats, endings and breaks do not decide which file measures go here. Check them against the file and fix a measure where it is wrong.",
      measures: alignment.ambiguous,
    });
  const conflicts = alignment.conflicts.flatMap((c, i) => (c ? [i] : []));
  if (conflicts.length)
    out.push({
      text: `${measuresWord(conflicts)} ${labelRanges(layout, conflicts)}: ${conflicts.length === 1 ? "differs" : "differ"} from the file`,
      title:
        "The file measure placed here has a repeat, ending or break the page does not show, or the other way round.",
      measures: conflicts,
    });
  const free = file.flatMap((_, i) => (held.has(i) ? [] : [i]));
  if (free.length)
    out.push({
      text: `File ${measuresWord(free).toLowerCase()} ${labelRanges(file, free)}: no place on the pages`,
      title:
        "These measures of the file are left out of the score. The uploaded file stays in the campaign unchanged.",
      measures: [],
    });
  if (staffMap.length !== staffCount)
    out.push({
      text: `The file has ${staffMap.length} staves, the pages ${staffCount}`,
      title:
        "The file's staves go to the page's staves from the top down or, where the pages name their instruments, to the staves with the same clef and the same place in a brace; staves without a counterpart stay empty or are left out.",
      measures: [],
    });
  const { movedEvents, crossStaffRemoved, neighbourRemoved, droppedGroups } =
    aligned.merged;
  if (movedEvents)
    out.push({
      text: `${movedEvents} ${movedEvents === 1 ? "mark" : "marks"} moved to the first staff from the file`,
      title:
        "Tempo, rehearsal marks, directions and dynamics on staves that are left out now stand on the first staff that comes from the file.",
      measures: [],
    });
  const crossStaff = crossStaffRemoved + neighbourRemoved;
  if (crossStaff)
    out.push({
      text: `${crossStaff} cross-staff ${crossStaff === 1 ? "note" : "notes"} returned to ${crossStaff === 1 ? "its" : "their"} own staff`,
      title:
        "These notes, chords, rests or beams were drawn on a staff that is left out or no longer next to theirs, so they stay on their own staff.",
      measures: [],
    });
  if (droppedGroups)
    out.push({
      text: `${droppedGroups} ${droppedGroups === 1 ? "brace or bracket" : "braces or brackets"} left out`,
      title:
        "A brace or bracket of the file is kept only where all its staves are used and stand next to each other in the same order.",
      measures: [],
    });
  for (const p of aligned.problems)
    out.push({
      text: p.text,
      title:
        "The merged score names something it does not contain. Submit is held until this is fixed.",
      measures: p.measure === null ? [] : [p.measure],
    });
  return out;
}
