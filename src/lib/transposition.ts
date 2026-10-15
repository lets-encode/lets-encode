// Transposing instruments in the score definition. A transposition is the
// interval from written to sounding pitch, as MEI records it on a staffDef:
// @trans.diat in diatonic steps and @trans.semi in semitones (a clarinet in
// B♭ sounds a major second lower: -1 and -2).

import { fifthsFor, keysigFor } from "./omr-musicxml.ts";

export interface Transposition {
  diat: number;
  semi: number;
}

/** The common transpositions the setup form lists, each named by its pitch and the instruments that use it. */
export const COMMON_TRANSPOSITIONS: (Transposition & { label: string })[] = [
  { diat: -1, semi: -2, label: "in B♭ (clarinet, trumpet)" },
  { diat: -2, semi: -3, label: "in A (clarinet)" },
  { diat: 2, semi: 3, label: "in E♭ (clarinet, trumpet)" },
  { diat: 1, semi: 2, label: "in D (trumpet, clarinet)" },
  { diat: 3, semi: 5, label: "in F (trumpet)" },
  { diat: -4, semi: -7, label: "in F (horn, cor anglais)" },
  { diat: -5, semi: -8, label: "in E (horn)" },
  { diat: -5, semi: -9, label: "in E♭ (horn, alto saxophone)" },
  { diat: -6, semi: -10, label: "in D (horn)" },
  { diat: -3, semi: -5, label: "in G (horn, alto flute)" },
  {
    diat: -8,
    semi: -14,
    label: "in B♭, octave lower (bass clarinet, tenor saxophone)",
  },
  { diat: -12, semi: -21, label: "in E♭, octave lower (baritone saxophone)" },
  {
    diat: -7,
    semi: -12,
    label: "Octave lower (double bass, contrabassoon, guitar)",
  },
  { diat: 7, semi: 12, label: "Octave higher (piccolo, celesta)" },
];

/** The pitches an instrument can be "in", as diatonic step and semitones above C. */
export const PITCHES: { name: string; step: number; semi: number }[] = [
  { name: "C", step: 0, semi: 0 },
  { name: "C♯", step: 0, semi: 1 },
  { name: "D♭", step: 1, semi: 1 },
  { name: "D", step: 1, semi: 2 },
  { name: "E♭", step: 2, semi: 3 },
  { name: "E", step: 2, semi: 4 },
  { name: "F", step: 3, semi: 5 },
  { name: "F♯", step: 3, semi: 6 },
  { name: "G♭", step: 4, semi: 6 },
  { name: "G", step: 4, semi: 7 },
  { name: "A♭", step: 5, semi: 8 },
  { name: "A", step: 5, semi: 9 },
  { name: "B♭", step: 6, semi: 10 },
  { name: "B", step: 6, semi: 11 },
];

/** A transposition described as the pitch the instrument is in, the direction it sounds and the octaves added. */
export interface CustomTransposition {
  pitch: string;
  higher: boolean;
  octaves: number;
}

/** The transposition of an instrument in `pitch` sounding higher or lower, plus whole octaves; null for an unknown pitch. */
export function fromCustom(c: CustomTransposition): Transposition | null {
  const p = PITCHES.find((x) => x.name === c.pitch);
  if (!p) return null;
  if (c.higher)
    return { diat: p.step + 7 * c.octaves, semi: p.semi + 12 * c.octaves };
  // An instrument in C sounding lower differs by its octaves alone; any other
  // sounds its pitch's distance below C.
  const diat = (p.step === 0 ? 0 : p.step - 7) - 7 * c.octaves;
  const semi = (p.semi === 0 ? 0 : p.semi - 12) - 12 * c.octaves;
  return { diat, semi };
}

/** The pitch, direction and octaves of a transposition; null when no listed pitch has its interval. */
export function toCustom(t: Transposition): CustomTransposition | null {
  const step = ((t.diat % 7) + 7) % 7;
  const semi = ((t.semi % 12) + 12) % 12;
  const p = PITCHES.find((x) => x.step === step && x.semi === semi);
  if (!p) return null;
  const higher = t.diat > 0 || (t.diat === 0 && t.semi > 0);
  const base = fromCustom({ pitch: p.name, higher, octaves: 0 })!;
  const octaves = Math.round(Math.abs(t.diat - base.diat) / 7);
  return { pitch: p.name, higher, octaves };
}

const isNone = (t: Transposition) => t.diat === 0 && t.semi === 0;

// Interval names by diatonic step, keyed by semitones within the octave.
const QUALITIES: Record<number, Record<number, string>> = {
  0: { 0: "", 1: "an augmented unison" },
  1: { 1: "a minor 2nd", 2: "a major 2nd" },
  2: { 3: "a minor 3rd", 4: "a major 3rd" },
  3: { 5: "a perfect 4th", 6: "an augmented 4th" },
  4: { 6: "a diminished 5th", 7: "a perfect 5th" },
  5: { 8: "a minor 6th", 9: "a major 6th" },
  6: { 10: "a minor 7th", 11: "a major 7th" },
};

/** How a transposed staff sounds: "a major 2nd lower", "an octave and a perfect 5th lower"; '' for none. */
export function soundsText(t: Transposition): string {
  if (isNone(t)) return "";
  const sign = t.diat < 0 || (t.diat === 0 && t.semi < 0) ? -1 : 1;
  const diat = Math.abs(t.diat);
  const semi = Math.abs(t.semi);
  const octaves = Math.floor(diat / 7);
  const simple = QUALITIES[diat % 7]?.[semi - 12 * octaves];
  const direction = sign < 0 ? "lower" : "higher";
  if (simple === undefined) return `${semi} semitones ${direction}`;
  const span =
    octaves === 0
      ? simple
      : [octaves === 1 ? "an octave" : `${octaves} octaves`, simple]
          .filter(Boolean)
          .join(" and ");
  return `${span} ${direction}`;
}

/**
 * The written key signature of a staff with transposition `t` in a score
 * whose untransposed staves have `concert` (MEI @keysig): the concert key
 * moved by the interval, kept within seven sharps or flats. A clarinet in
 * B♭ in a score in 1 flat reads 1 sharp.
 */
export function writtenKeysig(concert: string, t: Transposition): string {
  // An interval spans 7·semi − 12·diat fifths (a major 2nd is two).
  let fifths = fifthsFor(concert) - (7 * t.semi - 12 * t.diat);
  while (fifths > 7) fifths -= 12;
  while (fifths < -7) fifths += 12;
  return keysigFor(fifths);
}

/** A key signature as text: "1♯", "3♭", "None". */
export function keysigText(keysig: string): string {
  const m = /^([1-7])([sf])$/.exec(keysig);
  return m ? `${m[1]}${m[2] === "s" ? "♯" : "♭"}` : "None";
}

// Pitch names as labels write them, in English, German and Italian, mapped
// to the names above. German B is B♭ and H is B.
const PITCH_WORDS: Record<string, string> = {
  c: "C",
  d: "D",
  e: "E",
  f: "F",
  g: "G",
  a: "A",
  h: "B",
  b: "B♭",
  bb: "B♭",
  "b♭": "B♭",
  "b flat": "B♭",
  es: "E♭",
  eb: "E♭",
  "e♭": "E♭",
  "e flat": "E♭",
  as: "A♭",
  ab: "A♭",
  "a♭": "A♭",
  des: "D♭",
  db: "D♭",
  "d♭": "D♭",
  fis: "F♯",
  "f#": "F♯",
  "f♯": "F♯",
  do: "C",
  re: "D",
  mi: "E",
  "mi♭": "E♭",
  mib: "E♭",
  fa: "F",
  sol: "G",
  la: "A",
  si: "B",
  "si♭": "B♭",
  sib: "B♭",
};

// The instruments a label can name, each with the transpositions of the
// pitches it is built in, tried in order (the first match wins). A pitch an
// instrument comes in both an alto and a
// basso version of (horns in A, B♭ and C) is left out: the label alone does
// not settle it.
const INSTRUMENTS: {
  words: RegExp;
  pitches?: Record<string, [number, number]>;
  fixed?: [number, number];
}[] = [
  // Before the horns: "corno inglese" and "cor anglais" contain their word.
  {
    words: /\b(corn[oi] inglese|cor anglais|english horn|englischhorn)/,
    fixed: [-4, -7],
  },
  {
    words:
      /\b(bass ?clarinet|clarinetto basso|clarinetti bassi|bassklarinette|clarinette basse)/,
    pitches: { "B♭": [-8, -14], A: [-9, -15] },
  },
  {
    words: /\b(clarinet|clarinett|klarinett|cl\.|clar\.|kl\.)/,
    pitches: {
      C: [0, 0],
      D: [1, 2],
      "E♭": [2, 3],
      "B♭": [-1, -2],
      A: [-2, -3],
    },
  },
  {
    words: /\b(horn|hörner|corn[oi]|cors?\b|cor\.)/,
    pitches: {
      F: [-4, -7],
      E: [-5, -8],
      "E♭": [-5, -9],
      D: [-6, -10],
      G: [-3, -5],
    },
  },
  {
    words: /\b(trumpet|tromb[ae]|trompete|trompette|clarin[io]|tr\.|trp\.)/,
    pitches: {
      C: [0, 0],
      D: [1, 2],
      "E♭": [2, 3],
      E: [2, 4],
      F: [3, 5],
      "B♭": [-1, -2],
      A: [-2, -3],
    },
  },
  {
    words: /\b(cornet|cornett[oi]|kornett)/,
    pitches: { "B♭": [-1, -2], A: [-2, -3] },
  },
  {
    words: /\b(alto sax|saxophone alto|sax(ophon)?\.? ?alto|altsax)/,
    fixed: [-5, -9],
  },
  {
    words: /\b(tenor sax|saxophone ténor|sax(ophon)?\.? ?tenore?|tenorsax)/,
    fixed: [-8, -14],
  },
  {
    words:
      /\b(baritone sax|saxophone baryton|sax(ophon)?\.? ?baritono|baritonsax)/,
    fixed: [-12, -21],
  },
  { words: /\b(piccolo|ottavino|kleine flöte|petite flûte)/, fixed: [7, 12] },
  {
    words:
      /\b(double bass|contrabass(o|i)?\b|contrabbass[oi]|kontrabass|contrebasse)/,
    fixed: [-7, -12],
  },
  {
    words: /\b(contrabassoon|contrafagott[oi]|kontrafagott|contrebasson)/,
    fixed: [-7, -12],
  },
];

/**
 * The transposition an instrument label names, or null when it names none:
 * a transposing instrument and, where it comes in several pitches, the
 * pitch it is in ("Clarinetti in B", "Corni in F", "Cl. (A)", "Tromba in
 * Re"). An instrument in C, or a label without an instrument it knows,
 * gives null.
 */
export function transpositionFromLabel(label: string): Transposition | null {
  const text = label.toLowerCase().normalize("NFC");
  const instrument = INSTRUMENTS.find((i) => i.words.test(text));
  if (!instrument) return null;
  let found: [number, number] | undefined = instrument.fixed;
  if (instrument.pitches) {
    const m =
      /(?:\bin\s+|\(\s*)(b flat|e flat|[a-h](?:is|es|s|b|♭|#|♯)?|do|re|mi[b♭]?|fa|sol|la|si[b♭]?)(?=[\s).,;:]|$)/.exec(
        text,
      );
    const pitch = m ? PITCH_WORDS[m[1]] : undefined;
    found = pitch ? instrument.pitches[pitch] : undefined;
  }
  if (!found || (found[0] === 0 && found[1] === 0)) return null;
  return { diat: found[0], semi: found[1] };
}
