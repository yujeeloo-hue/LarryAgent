/**
 * Single-source tripwire for the inlined CoCo band path: the constant in
 * `cocoMonoMark.ts` must stay byte-for-byte equal to the asset file that
 * drives the animated icon (`assets/coco/running/band-16.txt`). If the
 * artwork ever changes, this fails until the constant is refreshed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COCO_BAND_PATH } from "./cocoMonoMark.js";

const assetPath = fileURLToPath(
  new URL("../assets/coco/running/band-16.txt", import.meta.url),
);

test("inlined CoCo band path matches the band-16 asset byte-for-byte", () => {
  const asset = readFileSync(assetPath, "utf8").trim();
  assert.equal(COCO_BAND_PATH, asset);
});
