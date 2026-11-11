// The measure correction's editing hints and outline legend, shown by the
// toolbar's help icon, and the instruments step's short explanation in the
// side panel.

// Shortcut names as the viewer's keyboard labels them.
export const mac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);
export const MOD = mac ? "⌘" : "Ctrl+";
export const SHIFT = mac ? "⇧" : "Shift+";
// A help line is text with colour words, each set in the colour it names.
export type HelpPart = string | { text: string; tone: string };

// The instruments step edits no boxes. The side panel says in short why
// it is done and how; the help (?) says it in full.
export const NAMING_WHY =
  "The automatic recognition reads each staff on its own and cannot tell which instrument the staff belongs to. The names put every staff on the right staff of the score.";
export const namingSteps = (canEdit: boolean): string[] =>
  canEdit
    ? [
        "First system: check or enter the name of each staff as printed, with its short name and its parts.",
        "One instrument on several staves gets one name with different parts: Flöte, parts I and II, not Flöte I and Flöte II.",
        "Other systems: choose each staff's instrument and parts from the list.",
        "If one instrument ends up with two names, such as Flöte and Flöte I, a warning appears. Its button “Make it Flöte, part I” joins them.",
      ]
    : [
        "Check that every staff has the right instrument and part.",
        "If a warning says an instrument is possibly named twice, such as Flöte and Flöte I, request changes: Flöte I should be Flöte with the part I.",
      ];

/** What the help says depends on. */
export interface HelpState {
  /** The instruments step is in view. */
  readonly step4: boolean;
  readonly canEdit: boolean;
  /** A touch screen. */
  readonly coarse: boolean;
  /** What one box of the active layer is called. */
  readonly boxName: string;
  readonly omr: boolean;
}

const namingHelp = (s: HelpState): HelpPart[][] => [
  [
    `${NAMING_WHY} Later systems often leave instruments out or print only short names, so the first system defines the instruments and the others choose from them. The names also make the score's list of instruments, with its brackets, braces and groups.`,
  ],
  ...(s.canEdit
    ? [
        [
          "First system: for every staff the instrument's full and short name and the parts it carries as printed (I, II; 1.2.3 for three players on one staff). The same name on several staves makes one instrument. A grand staff gets a part only where several players have one each (Harfe 1, Harfe 2: Harfe, parts 1 and 2). Groups join instruments printed together, such as the woodwinds.",
        ],
        [
          "Parts, not instruments: Fl. I and Fl. II on two staves are Flöte with the parts I and II, a staff both play is I.II. Named Flöte I and Flöte II they become two instruments in the score.",
        ],
        [
          "Other systems opens once the first system is named. Each staff gets an instrument of the list and its parts; New instrument… adds one (marked for the reviewer). The first system can still be changed; the other systems keep their choices.",
        ],
        [
          "“Possibly named twice”: an instrument named like another with more after it (Flöte I beside Flöte), the same, or like a part of another (Kontrabass beside Violoncello und Kontrabass). Also when there are more instruments than staves in the first system. “Make it Flöte, part I” fixes it on every page; undo restores it.",
        ],
        [
          "The names are filled in from the printed names and the systems before; check every one. The staves are transcribed meanwhile; Submit waits for it.",
        ],
      ]
    : [
        [
          "Beside every staff its instrument and, in grey, its parts; the column beside each system shows the brackets, braces and groups the names make (hover for the name).",
        ],
        [
          "“Possibly named twice” marks instruments that look like parts of another named on their own (Flöte I beside Flöte).",
        ],
      ]),
  [
    `The page button shows the whole pages instead of each system's beginning.${s.canEdit && !s.coarse ? ` ${MOD}Z undo, ${MOD}${SHIFT}Z redo.` : ""}`,
  ],
];

/** The help's lines for the step in view. */
export const helpLines = (s: HelpState): HelpPart[][] =>
  s.step4
    ? namingHelp(s)
    : [
        ...(s.canEdit && s.coarse
          ? [
              [
                `With draw mode on (the box with a finger in the toolbar) tap a box to select it, then drag it or its edges and corners, or drag on the page to draw a ${s.boxName}. With draw mode off a finger drag scrolls the pages, and a double tap on a box selects it and turns draw mode on; in draw mode a double tap on a box or on the page outside a box turns it off. Pinch to zoom.`,
              ],
              [
                "To resize without dragging, tap a corner dot of the selected box, then tap where the corner should go.",
              ],
              [
                `To select several boxes, choose Select several (the squares with a tick) in draw mode and tap them; tap a selected box to take it out. Drag one of them to move them all; Duplicate copies them below or beside them.`,
              ],
            ]
          : s.canEdit
            ? [
                [
                  `Drag on the page to draw a ${s.boxName}. Or click one corner, which leaves a cross, then the opposite corner. Drag a box to move it; its edges and corners resize it, or click a corner and then where it should go. ${MOD}drag a box to copy it.`,
                ],
                [
                  `Arrow keys move the selected box (${SHIFT}arrow moves 5 times as far). Esc removes the cross, then deselects the box.`,
                ],
                [
                  `${SHIFT}click a box to add it to the selection or take it out, or ${SHIFT}drag on the page to select every box the rectangle touches. Drag one of the selected boxes to move them all, ${MOD}drag to copy them all.`,
                ],
              ]
            : []),
        ...(s.coarse
          ? []
          : [
              [
                `${s.canEdit ? `${MOD}Z undo · ${MOD}${SHIFT}Z redo · ${mac ? "⌫" : "Delete"} removes the selected box · N adds a box beside it · ` : ""}Tab reaches a page's boxes, A D the previous and next box · ← → change pages${s.canEdit ? " when no box is selected" : ""} · ${MOD}scroll or a pinch zooms`,
              ],
            ]),
        [
          ...(s.omr
            ? [
                { text: "Wine red", tone: "staff" },
                ": staff · ",
                { text: "dark green", tone: "grand" },
                ": grand staff (staves one performer plays together, often joined by a brace) · ",
              ]
            : []),
          { text: "teal", tone: "measure" },
          ": measure · ",
          { text: "thick purple", tone: "movement" },
          ": section start · ",
          { text: "blue bracket before the number", tone: "system" },
          ": system start",
        ],
        [
          "Measure labels: the measure number, after a double bar where the measure starts a section.",
        ],
        [
          "A repeat start shows in the measure's label, a repeat end or double repeat in a label at the box's top right, an ending as a bracket with its number over its measures, and segno, coda, D.C., D.S., Fine and To Coda as tags at the box's bottom right.",
        ],
      ];
