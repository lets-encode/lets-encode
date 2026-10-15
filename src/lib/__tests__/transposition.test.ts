import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMON_TRANSPOSITIONS,
  fromCustom,
  soundsText,
  toCustom,
  transpositionFromLabel,
  writtenKeysig,
} from "../transposition.ts";

test("writtenKeysig moves the concert key by the transposition", () => {
  assert.equal(writtenKeysig("1f", { diat: -1, semi: -2 }), "1s");
  assert.equal(writtenKeysig("0", { diat: -4, semi: -7 }), "1s");
  assert.equal(writtenKeysig("3s", { diat: -2, semi: -3 }), "0");
  assert.equal(writtenKeysig("2s", { diat: 2, semi: 3 }), "5s");
  assert.equal(writtenKeysig("2s", { diat: 7, semi: 12 }), "2s");
  // Kept within seven sharps or flats.
  assert.equal(writtenKeysig("6s", { diat: -1, semi: -2 }), "4f");
});

test("soundsText names the interval and direction", () => {
  assert.equal(soundsText({ diat: 0, semi: 0 }), "");
  assert.equal(soundsText({ diat: -1, semi: -2 }), "a major 2nd lower");
  assert.equal(soundsText({ diat: -4, semi: -7 }), "a perfect 5th lower");
  assert.equal(soundsText({ diat: 7, semi: 12 }), "an octave higher");
  assert.equal(
    soundsText({ diat: -8, semi: -14 }),
    "an octave and a major 2nd lower",
  );
});

test("custom transpositions convert both ways", () => {
  for (const t of COMMON_TRANSPOSITIONS) {
    const c = toCustom(t);
    assert.ok(c, t.label);
    assert.deepEqual(fromCustom(c), { diat: t.diat, semi: t.semi }, t.label);
  }
  assert.deepEqual(fromCustom({ pitch: "B♭", higher: false, octaves: 0 }), {
    diat: -1,
    semi: -2,
  });
  assert.deepEqual(fromCustom({ pitch: "C", higher: false, octaves: 1 }), {
    diat: -7,
    semi: -12,
  });
  assert.deepEqual(toCustom({ diat: 6, semi: 10 }), {
    pitch: "B♭",
    higher: true,
    octaves: 0,
  });
});

test("transpositionFromLabel reads the instrument and its pitch", () => {
  const t = (label: string) => {
    const r = transpositionFromLabel(label);
    return r && [r.diat, r.semi];
  };
  assert.deepEqual(t("Clarinetti in B"), [-1, -2]);
  assert.deepEqual(t("Clarinet in Bb"), [-1, -2]);
  assert.deepEqual(t("Cl. (A)"), [-2, -3]);
  assert.deepEqual(t("Klarinette in Es"), [2, 3]);
  assert.deepEqual(t("Corni in F"), [-4, -7]);
  assert.deepEqual(t("Hörner in D"), [-6, -10]);
  assert.deepEqual(t("Trombe in D"), [1, 2]);
  assert.deepEqual(t("Tromba in Re"), [1, 2]);
  assert.deepEqual(t("Corno inglese"), [-4, -7]);
  assert.deepEqual(t("Bass Clarinet in B♭"), [-8, -14]);
  assert.deepEqual(t("Piccolo"), [7, 12]);
  assert.deepEqual(t("Contrabbasso"), [-7, -12]);
  assert.deepEqual(t("Contrafagotto"), [-7, -12]);
  // In C, an ambiguous horn pitch, a pitch missing and a non-transposing
  // instrument give none.
  assert.equal(t("Trombe in C"), null);
  assert.equal(t("Corni in C"), null);
  assert.equal(t("Clarinetti"), null);
  assert.equal(t("Violino I"), null);
  assert.equal(t("Fagotti"), null);
});
