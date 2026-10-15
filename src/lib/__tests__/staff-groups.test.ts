import { test } from "node:test";
import assert from "node:assert/strict";
import type { StaffGroupModel, StaffModel } from "../mei-facsimile.ts";
import {
  groupsValid,
  guessOneInstrument,
  moveStaffInGroups,
  removeStaffFromGroups,
  sortGroups,
  spanProblem,
} from "../staff-groups.ts";

const group = (
  start: number,
  end: number,
  symbol = "bracket",
  label = "",
): StaffGroupModel => ({
  start,
  end,
  symbol,
  label,
  barThru: true,
  oneInstrument: false,
});
const staff = (clefShape: string, label = ""): StaffModel => ({
  clefShape,
  clefLine: clefShape === "F" ? 4 : 2,
  clefDis: "",
  clefDisPlace: "",
  lines: 5,
  notationType: "",
  label,
});
const ranges = (groups: StaffGroupModel[]) =>
  sortGroups(groups).map((g) => [g.start, g.end]);

test("a span may hold or sit inside whole groups, two levels deep", () => {
  const groups = [group(1, 4), group(1, 2, "brace")];
  assert.equal(spanProblem(groups, 6, 8), null);
  assert.equal(spanProblem(groups, 3, 4), null);
  assert.equal(spanProblem(groups, 1, 6), "Groups nest at most 2 levels deep.");
  assert.equal(spanProblem(groups, 1, 1), "Groups nest at most 2 levels deep.");
  assert.equal(spanProblem(groups, 3, 6), "A group must contain whole groups.");
  assert.equal(spanProblem([group(1, 2, "brace")], 1, 4), null);
});

test("groups are valid nested or apart, within the staves, braces over two staves", () => {
  assert.ok(groupsValid([group(1, 4), group(1, 2, "brace"), group(5, 5)], 5));
  assert.ok(!groupsValid([group(1, 4), group(3, 6)], 6));
  assert.ok(!groupsValid([group(1, 4), group(1, 4, "brace")], 4));
  assert.ok(!groupsValid([group(1, 6)], 5));
  assert.ok(!groupsValid([group(2, 2, "brace")], 3));
  assert.ok(!groupsValid([group(1, 6), group(1, 4), group(1, 2)], 6));
});

test("a brace is guessed one instrument from its labels, else treble over bass", () => {
  const piano = [staff("G", "Pianoforte"), staff("F")];
  assert.equal(guessOneInstrument(group(1, 2, "brace"), piano), true);
  const horns = [staff("G", "Corno I"), staff("G", "Corno II")];
  assert.equal(guessOneInstrument(group(1, 2, "brace", "Corni"), horns), false);
  const unlabelled = [staff("G"), staff("G")];
  assert.equal(
    guessOneInstrument(group(1, 2, "brace", "Arpa"), unlabelled),
    true,
  );
  assert.equal(guessOneInstrument(group(1, 2, "brace"), unlabelled), false);
  assert.equal(
    guessOneInstrument(group(1, 2, "brace"), [staff("G"), staff("F")]),
    true,
  );
});

test("a group keeps its staves when a staff moves", () => {
  // Within its group a staff stays in it.
  assert.deepEqual(ranges(moveStaffInGroups([group(2, 3, "brace")], 5, 1, 2)), [
    [2, 3],
  ]);
  // Moved out, it leaves; the staves it passed close up.
  assert.deepEqual(ranges(moveStaffInGroups([group(2, 4)], 6, 1, 5)), [[2, 3]]);
  // Moved from before a group to after it, the group shifts up.
  assert.deepEqual(ranges(moveStaffInGroups([group(3, 4)], 6, 0, 5)), [[2, 3]]);
  // Dropped between two of a group's staves, it joins.
  assert.deepEqual(ranges(moveStaffInGroups([group(1, 2)], 4, 3, 1)), [[1, 3]]);
  // Dropped next to a group, it stays outside.
  assert.deepEqual(ranges(moveStaffInGroups([group(1, 2)], 4, 3, 2)), [[1, 2]]);
  // A brace left with one staff is dropped; nested groups shrink together.
  assert.deepEqual(
    ranges(moveStaffInGroups([group(1, 3), group(1, 2, "brace")], 4, 0, 3)),
    [[1, 2]],
  );
});

test("a group left over the same staves as another is dropped, a brace kept", () => {
  // A woodwind bracket over 1–3 holding a flute brace over 1–2 loses staff 3.
  const removed = removeStaffFromGroups([group(1, 3), group(1, 2, "brace")], 2);
  assert.deepEqual(
    removed.map((g) => [g.start, g.end, g.symbol]),
    [[1, 2, "brace"]],
  );
  const moved = moveStaffInGroups([group(1, 3), group(1, 2)], 4, 2, 3);
  assert.deepEqual(ranges(moved), [[1, 2]]);
  assert.ok(groupsValid(moved, 4));
});

test("removing a staff removes it from its groups", () => {
  assert.deepEqual(
    ranges(removeStaffFromGroups([group(1, 3), group(5, 6)], 1)),
    [
      [1, 2],
      [4, 5],
    ],
  );
  assert.deepEqual(removeStaffFromGroups([group(2, 2)], 1), []);
  assert.deepEqual(removeStaffFromGroups([group(1, 2, "brace")], 0), []);
});
