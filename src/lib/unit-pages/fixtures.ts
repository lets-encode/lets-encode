// Fixture documents and stand-in page images for the unit pages.

import { measure, skeleton, upload } from "../__tests__/encoding-fixture.ts";

/** A one-page layout skeleton of two systems with four measures each. */
export const SKELETON = skeleton([4, 4]);

/** An uploaded file of eight measures. */
export const UPLOAD = upload(
  Array.from({ length: 8 }, (_, i) => measure(i + 1)).join(""),
);

/** A blank page image of the skeleton's page size, as an address. */
export function blankPage(width = 2000, height = 2800): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = width / 4;
  canvas.height = height / 4;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(URL.createObjectURL(blob!))),
  );
}
