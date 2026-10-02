import test from "node:test";
import assert from "node:assert/strict";
import { findRelease } from "./release";

const sha = "a".repeat(64);
const answering = (bodies: Record<string, unknown>) =>
  (async (url: string) => ({
    ok: url in bodies,
    status: url in bodies ? 200 : 404,
    json: async () => bodies[url],
  })) as unknown as typeof fetch;

test("a Codex update takes its package digest from the release and a fixed download host", async () => {
  const release = await findRelease(
    "codex",
    "0.160.0",
    "darwin-arm64",
    answering({
      "https://api.github.com/repos/openai/codex/releases/tags/rust-v0.160.0": {
        assets: [
          {
            name: "codex-package-aarch64-apple-darwin.tar.zst",
            digest: `sha256:${sha}`,
            size: 10,
            browser_download_url: "https://elsewhere.invalid/codex",
          },
        ],
      },
    }),
  );
  assert.deepEqual(release, {
    version: "0.160.0",
    asset: {
      url: "https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-package-aarch64-apple-darwin.tar.zst",
      file: "bin/codex",
      download: { sha256: sha, size: 10 },
      compression: "zstd",
      archive: "tar",
    },
  });
});

test("a Claude Code update takes its digest from the published manifest", async () => {
  const manifest = (version: string) =>
    answering({
      "https://downloads.claude.ai/claude-code-releases/2.1.287/manifest.json":
        { version, platforms: { "win32-x64": { checksum: sha, size: 7 } } },
    });
  assert.deepEqual(
    (await findRelease("claude", "2.1.287", "win32-x64", manifest("2.1.287")))
      .asset,
    {
      url: "https://downloads.claude.ai/claude-code-releases/2.1.287/win32-x64/claude.exe",
      file: "claude.exe",
      download: { sha256: sha, size: 7 },
    },
  );
  // A manifest for another version, or no build for the platform, is refused.
  await assert.rejects(
    findRelease("claude", "2.1.287", "win32-x64", manifest("2.1.286")),
  );
  await assert.rejects(
    findRelease("claude", "2.1.287", "darwin-arm64", manifest("2.1.287")),
  );
});

test("a release without a digest, a missing release, or a non-release version is refused", async () => {
  await assert.rejects(
    findRelease(
      "codex",
      "0.160.0",
      "linux-x64",
      answering({
        "https://api.github.com/repos/openai/codex/releases/tags/rust-v0.160.0":
          {
            assets: [
              { name: "codex-package-x86_64-unknown-linux-musl.tar.zst" },
            ],
          },
      }),
    ),
  );
  await assert.rejects(
    findRelease("codex", "0.160.0", "linux-x64", answering({})),
  );
  await assert.rejects(
    findRelease("codex", "0.162.0-alpha.1", "linux-x64", answering({})),
  );
});
