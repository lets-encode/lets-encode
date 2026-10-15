// Staff groups of a score definition (StaffGroupModel): braces and brackets
// over runs of staves. Groups nest by their ranges: a group whose staves lie
// within another's is inside it. Two levels below the root <staffGrp> are
// allowed, and two groups either nest or share no staff.

import type { StaffGroupModel, StaffModel } from "./mei-facsimile.ts";

/** How deep groups may nest below the root <staffGrp>. */
export const MAX_GROUP_DEPTH = 2;

type Span = { start: number; end: number };
const contains = (a: Span, b: Span) => a.start <= b.start && b.end <= a.end;
const overlaps = (a: Span, b: Span) => a.start <= b.end && b.start <= a.end;

/** Groups in document order: by first staff, an outer group before the groups inside it. */
export function sortGroups(groups: StaffGroupModel[]): StaffGroupModel[] {
  return [...groups].sort((a, b) => a.start - b.start || b.end - a.end);
}

/** How many groups contain this one (0 for an outer group). */
export function groupDepth(
  groups: StaffGroupModel[],
  group: StaffGroupModel,
): number {
  return groups.filter((g) => g !== group && contains(g, group)).length;
}

/**
 * Why a new group over staves `start`–`end` (1-based, inclusive) cannot join
 * the existing ones, or null when it can. A span equal to an existing
 * group's is the caller's to handle.
 */
export function spanProblem(
  groups: StaffGroupModel[],
  start: number,
  end: number,
): string | null {
  const span = { start, end };
  const crosses = groups.some(
    (g) => overlaps(g, span) && !contains(g, span) && !contains(span, g),
  );
  if (crosses) return "A group must contain whole groups.";
  // The new group sits one level below the groups containing it, and the
  // groups inside it one level below it.
  const above = groups.filter((g) => contains(g, span)).length;
  const inside = groups.filter((g) => contains(span, g));
  const below = inside.length
    ? 1 +
      Math.max(
        ...inside.map(
          (g) => inside.filter((h) => h !== g && contains(h, g)).length,
        ),
      )
    : 0;
  if (above + 1 + below > MAX_GROUP_DEPTH)
    return `Groups nest at most ${MAX_GROUP_DEPTH} levels deep.`;
  return null;
}

/**
 * Whether the groups fit a definition of `staffCount` staves: each within
 * the staves, a brace over two staves or more, no two over the same staves,
 * any two nested or apart, at most MAX_GROUP_DEPTH levels deep.
 */
export function groupsValid(
  groups: StaffGroupModel[],
  staffCount: number,
): boolean {
  return groups.every(
    (g, i) =>
      g.start >= 1 &&
      g.end <= staffCount &&
      g.start <= g.end &&
      (g.symbol !== "brace" || g.end > g.start) &&
      groups.every(
        (h, j) =>
          i === j ||
          (!(h.start === g.start && h.end === g.end) &&
            (!overlaps(g, h) || contains(g, h) || contains(h, g))),
      ) &&
      groupDepth(groups, g) < MAX_GROUP_DEPTH,
  );
}

/**
 * The guess whether a brace's staves are one instrument (a piano, a harp)
 * rather than several (Horn 1, 2): two or more labelled staves are separate
 * instruments; else a group label names one; else a treble staff over a bass
 * staff is one.
 */
export function guessOneInstrument(
  group: Pick<StaffGroupModel, "start" | "end" | "label">,
  staves: StaffModel[],
): boolean {
  const members = staves.slice(group.start - 1, group.end);
  if (members.filter((s) => s.label.trim()).length >= 2) return false;
  if (group.label.trim()) return true;
  return (
    members.length === 2 &&
    members[0].clefShape === "G" &&
    members[1].clefShape === "F"
  );
}

// The groups' ranges are rewritten in place so a caller's group objects keep
// their identity; a group left empty, a brace left with one staff, and a
// group left over the same staves as another are dropped from the returned
// list. Of two groups over the same staves a brace is kept, else the first.
function keepFitting(groups: StaffGroupModel[]): StaffGroupModel[] {
  const fitting = groups.filter(
    (g) => g.end >= g.start && (g.symbol !== "brace" || g.end > g.start),
  );
  return fitting.filter((g, i) =>
    fitting.every(
      (h, j) =>
        j === i ||
        h.start !== g.start ||
        h.end !== g.end ||
        (g.symbol === "brace" && h.symbol !== "brace") ||
        (j > i && (g.symbol === "brace") === (h.symbol === "brace")),
    ),
  );
}

/**
 * The groups after the staff at index `from` (0-based) moved to index `to`,
 * the others closing up behind it and making room in front of it. A group
 * keeps its staves: a staff moved within its group stays in it, one moved
 * out of its group leaves it, and one dropped between two staves of a group
 * joins it.
 */
export function moveStaffInGroups(
  groups: StaffGroupModel[],
  staffCount: number,
  from: number,
  to: number,
): StaffGroupModel[] {
  const order = Array.from({ length: staffCount }, (_, i) => i);
  order.splice(from, 1);
  order.splice(to, 0, from);
  const at = (staff: number) => order.indexOf(staff);
  for (const g of groups) {
    const a = g.start - 1;
    const b = g.end - 1;
    const isMember = from >= a && from <= b;
    if (isMember && to >= a && to <= b) continue;
    const others = order.filter((s) => s !== from && s >= a && s <= b).map(at);
    if (!others.length) {
      g.end = g.start - 1;
      continue;
    }
    const lo = Math.min(...others);
    const hi = Math.max(...others);
    g.start = lo + 1;
    g.end = hi + 1;
  }
  return keepFitting(groups);
}

/** The groups after the staff at index `index` (0-based) is removed. */
export function removeStaffFromGroups(
  groups: StaffGroupModel[],
  index: number,
): StaffGroupModel[] {
  const n = index + 1;
  for (const g of groups) {
    if (g.start > n) g.start--;
    if (g.end >= n) g.end--;
  }
  return keepFitting(groups);
}
