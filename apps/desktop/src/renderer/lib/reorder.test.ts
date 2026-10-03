import test from "node:test";
import assert from "node:assert/strict";
import { moved, ordered } from "./reorder";

const self = (value: string) => value;

test("a saved order wins, and unsaved items go first or last", () => {
  assert.deepEqual(ordered(["a", "b", "c", "d"], self, ["c", "a"], "last"), [
    "c",
    "a",
    "b",
    "d",
  ]);
  assert.deepEqual(ordered(["new", "a", "b"], self, ["b", "a"], "first"), [
    "new",
    "b",
    "a",
  ]);
  // A saved ID with no item left is skipped.
  assert.deepEqual(ordered(["a"], self, ["gone", "a"], "last"), ["a"]);
});

test("moving places an item before or after its target", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moved(ids, "a", "c", false), ["b", "a", "c", "d"]);
  assert.deepEqual(moved(ids, "a", "c", true), ["b", "c", "a", "d"]);
  assert.deepEqual(moved(ids, "d", "a", false), ["d", "a", "b", "c"]);
  assert.deepEqual(moved(ids, "b", "b", true), ids);
  assert.deepEqual(moved(ids, "a", "missing", true), ids);
});
