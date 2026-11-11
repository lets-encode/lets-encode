import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeasureBox, PageModel, ZoneModel } from "../mei-facsimile.ts";
import {
  boxNameOf,
  boxNamesOf,
  clonePages,
  editPagesFrom,
  itemName,
  layerItems,
  overlaps,
  staffRoom,
  toPageModels,
  type EditPage,
  type EditZone,
} from "../zones/edit-pages.ts";
import {
  endingRuns,
  markNames,
  renumber,
  resort,
  resortStaves,
  sbActive,
  startsMovement,
  zoneTitle,
} from "../zones/measures.ts";

const box = (ulx: number, uly: number, lrx: number, lry: number) => ({
  ulx,
  uly,
  lrx,
  lry,
});

const zoneModel = (
  b: MeasureBox,
  label: string,
  more: Partial<ZoneModel> = {},
): ZoneModel => ({ box: b, label, pb: false, sb: false, mdiv: false, ...more });

const pageModel = (zones: ZoneModel[], more: Partial<PageModel> = {}) => ({
  image: "img/01.jpg",
  width: 1000,
  height: 1000,
  zones,
  ...more,
});

const editZone = (b: MeasureBox, more: Partial<EditZone> = {}): EditZone => ({
  box: b,
  override: null,
  label: "",
  sb: false,
  sbOverride: null,
  mdiv: false,
  pickup: false,
  ...more,
});

const editPage = (
  zones: EditZone[],
  more: Partial<EditPage> = {},
): EditPage => ({
  image: "img/01.jpg",
  width: 1000,
  height: 1000,
  url: "https://example.org/01.jpg",
  failed: false,
  zones,
  staves: [],
  grandstaves: [],
  regions: [],
  ...more,
});

test("editPagesFrom keeps a label that differs from the automatic numbering as an override", () => {
  const pages = editPagesFrom({
    model: {
      pages: [
        pageModel([
          zoneModel(box(0, 0, 100, 100), "1", { pb: true }),
          zoneModel(box(100, 0, 200, 100), "10"),
          zoneModel(box(200, 0, 300, 100), "11"),
        ]),
      ],
    } as never,
    regions: [[]],
    imageUrls: ["https://example.org/01.jpg"],
  });
  assert.deepEqual(
    pages[0].zones.map((z) => z.override),
    [null, "10", null],
  );
  assert.deepEqual(
    pages[0].zones.map((z) => z.label),
    ["1", "10", "11"],
  );
  assert.equal(pages[0].failed, false);
});

test("editPagesFrom drops the boxes outside the piece's regions and renumbers", () => {
  const pages = editPagesFrom({
    model: {
      pages: [
        pageModel(
          [
            zoneModel(box(0, 0, 100, 100), "5"),
            zoneModel(box(700, 0, 800, 100), "6"),
            zoneModel(box(100, 0, 200, 100), "7"),
          ],
          {
            staves: [
              { ...box(0, 0, 400, 50), staff: "s1" },
              box(600, 0, 900, 50),
            ],
          },
        ),
      ],
    } as never,
    regions: [[box(0, 0, 500, 1000)]],
    imageUrls: [""],
  });
  assert.deepEqual(
    pages[0].zones.map((z) => z.label),
    ["1", "2"],
  );
  assert.deepEqual(pages[0].staves, [{ box: box(0, 0, 400, 50), staff: "s1" }]);
  assert.equal(pages[0].failed, true);
});

test("editPagesFrom records a system start that differs from the rows as set by hand", () => {
  const pages = editPagesFrom({
    model: {
      pages: [
        pageModel([
          zoneModel(box(0, 0, 100, 100), "1", { pb: true }),
          zoneModel(box(100, 0, 200, 100), "2", { sb: true }),
          zoneModel(box(0, 200, 100, 300), "3", { sb: false }),
          zoneModel(box(100, 200, 200, 300), "4"),
        ]),
      ],
    } as never,
    regions: [[]],
    imageUrls: ["u"],
  });
  assert.deepEqual(
    pages[0].zones.map((z) => z.sbOverride),
    [null, true, false, null],
  );
});

test("renumber numbers a pickup and the measure before it as halves", () => {
  const pages = [
    editPage([
      editZone(box(0, 0, 100, 100)),
      editZone(box(100, 0, 200, 100), { pickup: true }),
      editZone(box(200, 0, 300, 100)),
    ]),
  ];
  renumber(pages);
  assert.deepEqual(
    pages[0].zones.map((z) => z.label),
    ["1a", "1b", "2"],
  );
});

test("resort puts a page's measures in reading order, starts systems from the rows and renumbers", () => {
  const a = editZone(box(0, 0, 100, 100));
  const b = editZone(box(100, 0, 200, 100));
  const c = editZone(box(0, 200, 100, 300));
  const d = editZone(box(100, 200, 200, 300), { sbOverride: true });
  const pages = [editPage([d, c, b, a])];
  resort(pages, 0);
  assert.deepEqual(pages[0].zones, [a, b, c, d]);
  assert.deepEqual(
    pages[0].zones.map((z) => [z.label, z.sb]),
    [
      ["1", false],
      ["2", false],
      ["3", true],
      ["4", true],
    ],
  );
});

test("resortStaves keeps staff boxes top to bottom, then left to right", () => {
  const pages = [
    editPage([], {
      staves: [
        { box: box(500, 100, 900, 150) },
        { box: box(0, 100, 400, 150) },
        { box: box(0, 0, 400, 50) },
      ],
    }),
  ];
  resortStaves(pages, 0);
  assert.deepEqual(
    pages[0].staves.map((s) => s.box.ulx + "/" + s.box.uly),
    ["0/0", "0/100", "500/100"],
  );
});

test("the score's first measure starts a section and every page's first measure a system", () => {
  const pages = [
    editPage([editZone(box(0, 0, 1, 1)), editZone(box(1, 0, 2, 1))]),
    editPage([editZone(box(0, 0, 1, 1), { mdiv: true })]),
  ];
  assert.equal(startsMovement(pages, 0, 0), true);
  assert.equal(startsMovement(pages, 0, 1), false);
  assert.equal(startsMovement(pages, 1, 0), true);
  assert.equal(sbActive(pages, 1, 0), true);
  assert.equal(sbActive(pages, 0, 1), false);
});

test("markNames and zoneTitle name a measure's marks and breaks", () => {
  const zone = editZone(box(0, 0, 1, 1), {
    rptStart: true,
    ending: "1",
    signs: ["segno"],
  });
  assert.deepEqual(markNames(zone), ["Repeat start", "Ending 1", "Segno"]);
  assert.equal(
    zoneTitle([editPage([zone])], 0, 0),
    "Starts a section · First measure on the page: starts a system · Repeat start · Ending 1 · Segno",
  );
});

test("endingRuns joins measures of one ending in a system and closes a bracket another ending follows", () => {
  const pages = [
    editPage([
      editZone(box(0, 10, 100, 100), { ending: "1" }),
      editZone(box(100, 0, 200, 100), { ending: "1" }),
      editZone(box(200, 0, 300, 100), { ending: "2" }),
      editZone(box(0, 200, 100, 300), { ending: "2", sb: true }),
    ]),
  ];
  assert.deepEqual(endingRuns(pages, 0), [
    { ulx: 0, uly: 0, lrx: 200, n: "1", closed: true },
    { ulx: 200, uly: 0, lrx: 300, n: "2", closed: false },
    { ulx: 0, uly: 200, lrx: 100, n: "2", closed: false },
  ]);
});

test("overlaps gives the intersection of each overlapping pair on a layer", () => {
  const pg = editPage(
    [
      editZone(box(0, 0, 100, 100)),
      editZone(box(50, 50, 150, 150)),
      editZone(box(300, 300, 400, 400)),
    ],
    { staves: [{ box: box(0, 0, 10, 10) }] },
  );
  assert.deepEqual(overlaps(pg, "measures"), [box(50, 50, 100, 100)]);
  assert.deepEqual(overlaps(pg, "staves"), []);
});

test("staffRoom measures the free space to the nearest box above and below", () => {
  const list = [
    { box: box(0, 0, 100, 50) },
    { box: box(0, 80, 100, 120) },
    { box: box(0, 200, 100, 250) },
    { box: box(500, 60, 600, 70) },
  ];
  assert.deepEqual(staffRoom(list, 1), { top: 30, bottom: 80 });
  assert.deepEqual(staffRoom(list, 3), { top: Infinity, bottom: Infinity });
});

test("toPageModels marks each page's first measure as the page break and adds staves for a layout task", () => {
  const pages = [
    editPage(
      [
        editZone(box(0, 0, 1, 1), { label: "1", rptEnd: false, signs: [] }),
        editZone(box(1, 0, 2, 1), { label: "2", ending: "1" }),
      ],
      {
        staves: [{ box: box(0, 0, 5, 1), staff: "s1" }],
        grandstaves: [{ box: box(0, 0, 5, 2) }],
      },
    ),
  ];
  const [zones] = toPageModels(pages, false);
  assert.deepEqual(
    zones.zones.map((z) => [z.label, z.pb, z.rptEnd, z.signs, z.ending]),
    [
      ["1", true, undefined, undefined, undefined],
      ["2", false, undefined, undefined, "1"],
    ],
  );
  assert.equal(zones.staves, undefined);
  const [layout] = toPageModels(pages, true);
  assert.deepEqual(layout.staves, [{ ...box(0, 0, 5, 1), staff: "s1" }]);
  assert.deepEqual(layout.grandstaves, [box(0, 0, 5, 2)]);
});

test("clonePages copies the boxes, so a change to the copy leaves the pages alone", () => {
  const pages = [
    editPage([editZone(box(0, 0, 1, 1))], {
      staves: [{ box: box(0, 0, 2, 2) }],
    }),
  ];
  const copy = clonePages(pages);
  copy[0].zones[0].box.lrx = 9;
  copy[0].staves[0].box.lrx = 9;
  assert.equal(pages[0].zones[0].box.lrx, 1);
  assert.equal(pages[0].staves[0].box.lrx, 2);
});

test("layers name their boxes and give their items", () => {
  const pages = [
    editPage([editZone(box(0, 0, 1, 1), { label: "12" })], {
      staves: [{ box: box(0, 0, 2, 2) }],
    }),
  ];
  assert.equal(layerItems(pages[0], "staves"), pages[0].staves);
  assert.equal(itemName(pages, "measures", 0, 0), "Measure 12");
  assert.equal(itemName(pages, "grandstaves", 0, 1), "Grand staff 2");
  assert.equal(boxNameOf("grandstaves"), "grand staff");
  assert.equal(boxNamesOf("staves"), "staves");
});
