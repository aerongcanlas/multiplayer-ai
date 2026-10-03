import test from "node:test";
import assert from "node:assert/strict";
import { emptyHistory, step, visit, type Location } from "./navigation";

const at = (roomId: string, tabId: string | null = null): Location => ({
  roomId,
  tabId,
  sharedTabId: null,
});
const always = () => true;

test("visits stack up, repeats are ignored, and a new visit drops forward entries", () => {
  let history = visit(visit(emptyHistory, at("a")), at("a"));
  assert.equal(history.entries.length, 1);
  history = visit(visit(history, at("b")), at("b", "t1"));
  const back = step(history, -1, always)!;
  assert.deepEqual(back.location, at("b"));
  history = visit(back.history, at("c"));
  assert.deepEqual(
    history.entries.map((item) => item.roomId),
    ["a", "b", "c"],
  );
  assert.equal(step(history, 1, always), null);
});

test("stepping skips places that no longer exist", () => {
  const history = [at("a"), at("gone"), at("c")].reduce(visit, emptyHistory);
  const back = step(history, -1, (item) => item.roomId !== "gone")!;
  assert.deepEqual(back.location, at("a"));
  assert.equal(back.history.index, 0);
  assert.deepEqual(step(back.history, 1, always)!.location, at("gone"));
  assert.equal(step(back.history, -1, always), null);
});
