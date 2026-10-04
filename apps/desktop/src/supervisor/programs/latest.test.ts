import test from "node:test";
import assert from "node:assert/strict";
import { latestVersion } from "./latest";
import { HARNESS_MANIFEST } from "./manifest";
import { opencodeLine } from "./release";
import { newerVersion } from "../../shared/tabs";

const answering = (body: unknown, ok = true) =>
  (async (url: string) => {
    assert.equal(url, "https://registry.npmjs.org/@openai/codex/latest");
    return { ok, json: async () => body };
  }) as unknown as typeof fetch;

test("the newest published version is read, and anything else is no answer", async () => {
  assert.deepEqual(
    await latestVersion("codex", answering({ version: "0.160.0" })),
    { version: "0.160.0" },
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

test("OpenCode updates stay within the pinned minor line", async () => {
  const line = opencodeLine(HARNESS_MANIFEST.opencode.version);
  const registry = (latest: string, newestPatch: number) =>
    (async (url: string) => {
      const tag = url.slice("https://registry.npmjs.org/opencode-ai/".length);
      const version =
        tag === "latest"
          ? latest
          : tag.startsWith(line) && Number(tag.slice(line.length)) <= newestPatch
            ? tag
            : null;
      return { ok: Boolean(version), json: async () => ({ version }) };
    }) as unknown as typeof fetch;
  const [major, minor] = line.split(".").map(Number);
  // A newer minor is offered only after an app update; the newest patch in line is installable.
  assert.deepEqual(
    await latestVersion("opencode", registry(`${major}.${minor! + 1}.0`, 40)),
    { version: `${line}40`, later: `${major}.${minor! + 1}.0` },
  );
  assert.deepEqual(
    await latestVersion("opencode", registry(`${line}50`, 50)),
    { version: `${line}50` },
  );
});

test("versions compare number by number", () => {
  assert.equal(newerVersion("0.160.0", "0.155.1"), true);
  assert.equal(newerVersion("2.1.280", "2.1.280"), false);
  assert.equal(newerVersion("2.1.99", "2.1.280"), false);
  assert.equal(newerVersion("1.0.0", "0.160.0"), true);
});
