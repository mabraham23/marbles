import test from "node:test";
import assert from "node:assert/strict";

import { applySignature, signatureList } from "./signatures.js";

test("applySignature: first win writes the name, later wins add tallies", () => {
  let sigs = applySignature(null, "id-1", "Mark", 1_000);
  assert.deepEqual(sigs["id-1"], { name: "Mark", tallies: 1, firstSignedAt: 1_000, lastWonAt: 1_000 });

  sigs = applySignature(sigs, "id-1", "Mark", 2_000);
  assert.equal(sigs["id-1"].tallies, 2);
  assert.equal(sigs["id-1"].firstSignedAt, 1_000);
  assert.equal(sigs["id-1"].lastWonAt, 2_000);
});

test("applySignature: the signed name is permanent ink across renames", () => {
  let sigs = applySignature({}, "id-1", "Mark", 1_000);
  sigs = applySignature(sigs, "id-1", "TotallyNotMark", 2_000);
  assert.equal(sigs["id-1"].name, "Mark");
  assert.equal(sigs["id-1"].tallies, 2);
});

test("signatureList: public view drops ids and orders by first signing", () => {
  let sigs = applySignature({}, "id-2", "Later", 5_000);
  sigs = applySignature(sigs, "id-1", "Early", 1_000);
  const list = signatureList(sigs);
  assert.deepEqual(list.map((s) => s.name), ["Early", "Later"]);
  assert.equal("id-1" in (list[0] || {}), false);
  assert.deepEqual(Object.keys(list[0]).sort(), ["firstSignedAt", "name", "tallies"]);
});
