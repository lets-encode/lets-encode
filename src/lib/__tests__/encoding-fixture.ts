// Shared fixtures for the encoding alignment and merge tests: a layout
// skeleton as a layout correction leaves it, and small uploaded files.

import {
  buildFacsimileMei,
  DEFAULT_SCORE_DEF,
  type ZoneModel,
} from "../mei-facsimile.ts";

export const HEAD =
  "   <meiHead><fileDesc><titleStmt><title>t</title></titleStmt><pubStmt/></fileDesc></meiHead>";

/**
 * A one-page skeleton with systems of `systems` measures, labelled from 1,
 * empty measures of `staffCount` staves. `flags` adds zone fields by measure
 * index.
 */
export function skeleton(
  systems: number[],
  staffCount = 1,
  flags: Record<number, Partial<ZoneModel>> = {},
): string {
  let index = 0;
  const zones: ZoneModel[] = systems.flatMap((count, s) =>
    Array.from({ length: count }, (_, i) => {
      const zone: ZoneModel = {
        box: {
          ulx: 100 + i * 200,
          uly: 100 + s * 300,
          lrx: 290 + i * 200,
          lry: 350 + s * 300,
        },
        label: String(index + 1),
        pb: index === 0,
        sb: i === 0 && index > 0,
        mdiv: false,
        ...flags[index],
      };
      index++;
      return zone;
    }),
  );
  return buildFacsimileMei(
    {
      headXml: HEAD,
      scoreDef: {
        ...DEFAULT_SCORE_DEF,
        staves: Array.from(
          { length: staffCount },
          () => DEFAULT_SCORE_DEF.staves[0],
        ),
      },
      pages: [{ image: "img/01.jpg", width: 2000, height: 2800, zones }],
    },
    { withBreaks: true, emptyMeasures: true, padZones: true },
  );
}

/** One staff with one quarter note, or an empty layer when `empty`. */
export const staff = (n: number, empty = false): string =>
  empty
    ? `<staff n="${n}"><layer n="1"/></staff>`
    : `<staff n="${n}"><layer n="1"><note pname="c" oct="4" dur="4"/></layer></staff>`;

/** A file measure labelled `n` with one note on each of `staves` staves. */
export const measure = (n: string | number, staves = 1, attrs = ""): string =>
  `<measure n="${n}"${attrs}>${Array.from({ length: staves }, (_, k) => staff(k + 1)).join("")}</measure>`;

/** An uploaded MEI file with `section` as its section's content. */
export function upload(
  section: string,
  scoreDef = `<scoreDef keysig="2s" meter.count="3" meter.unit="4"><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/></staffGrp></scoreDef>`,
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1">` +
    `<meiHead><fileDesc><titleStmt><title>u</title></titleStmt><pubStmt/></fileDesc></meiHead>` +
    `<music><body><mdiv><score>${scoreDef}<section>${section}</section></score></mdiv></body></music></mei>`
  );
}
