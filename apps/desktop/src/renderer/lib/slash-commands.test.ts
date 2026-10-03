import test from "node:test";
import assert from "node:assert/strict";
import { matchCommands, slashQuery } from "./slash-commands";

test("a slash query is a draft that is only a leading /name", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/Rev"), "rev");
  assert.equal(slashQuery("/plugin:review"), "plugin:review");
  assert.equal(slashQuery("/review "), null);
  assert.equal(slashQuery("/review the diff"), null);
  assert.equal(slashQuery(" /review"), null);
  assert.equal(slashQuery("see /review"), null);
  assert.equal(slashQuery(""), null);
});

test("prefix matches come before matches inside the name", () => {
  const commands = ["code-review", "review", "plan", "engineering:review"].map(
    (name) => ({ name, description: "" }),
  );
  assert.deepEqual(
    matchCommands(commands, "review").map((command) => command.name),
    ["review", "code-review", "engineering:review"],
  );
  assert.deepEqual(
    matchCommands(commands, "").map((command) => command.name),
    ["code-review", "review", "plan", "engineering:review"],
  );
  assert.deepEqual(matchCommands(commands, "zzz"), []);
});
