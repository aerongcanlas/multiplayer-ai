import test from "node:test";
import assert from "node:assert/strict";
import { latestVersion } from "./latest";
import { newerVersion } from "../../shared/tabs";

const answering = (body: unknown, ok = true) =>
  (async (url: string) => {
    assert.equal(url, "https://registry.npmjs.org/@openai/codex/latest");
    return { ok, json: async () => body };
  }) as unknown as typeof fetch;

test("the newest published version is read, and anything else is no answer", async () => {
  assert.equal(
    await latestVersion("codex", answering({ version: "0.160.0" })),
    "0.160.0",
  );
  assert.equal(
    await latestVersion("codex", answering({ version: "0.162.0-alpha.1" })),
    null,
  );
  assert.equal(await latestVersion("codex", answering({}, false)), null);
  assert.equal(
    await latestVersion("codex", (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch),
    null,
  );
});

test("versions compare number by number", () => {
  assert.equal(newerVersion("0.160.0", "0.155.1"), true);
  assert.equal(newerVersion("2.1.280", "2.1.280"), false);
  assert.equal(newerVersion("2.1.99", "2.1.280"), false);
  assert.equal(newerVersion("1.0.0", "0.160.0"), true);
});
