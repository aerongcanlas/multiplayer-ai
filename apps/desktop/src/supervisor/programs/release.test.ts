import test from "node:test";
import assert from "node:assert/strict";
import { findRelease, OPENCODE_PACKAGES, opencodeLine } from "./release";
import { HARNESS_MANIFEST } from "./manifest";

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

test("an OpenCode update takes npm's integrity and builds its download URL from the fixed registry", async () => {
  const line = opencodeLine();
  const version = `${line}99`;
  const integrity = `sha512-${"A".repeat(86)}==`;
  const release = await findRelease(
    "opencode",
    version,
    "win32-x64",
    answering({
      [`https://registry.npmjs.org/opencode-windows-x64/${version}`]: {
        version,
        dist: {
          integrity,
          // A response pointing elsewhere does not move the download.
          tarball: "https://elsewhere.invalid/opencode.tgz",
        },
      },
    }),
  );
  assert.deepEqual(release, {
    version,
    asset: {
      url: `https://registry.npmjs.org/opencode-windows-x64/-/opencode-windows-x64-${version}.tgz`,
      file: "package/bin/opencode.exe",
      download: { integrity },
      compression: "gzip",
      archive: "tar",
    },
  });
  await assert.rejects(
    findRelease(
      "opencode",
      version,
      "darwin-arm64",
      answering({
        [`https://registry.npmjs.org/opencode-darwin-arm64/${version}`]: {
          version,
          dist: { shasum: "abc" },
        },
      }),
    ),
    /no verified build/,
  );
  // A newer minor line needs an app update.
  const [major, minor] = line.split(".").map(Number);
  await assert.rejects(
    findRelease(
      "opencode",
      `${major}.${minor! + 1}.0`,
      "darwin-arm64",
      answering({}),
    ),
    /after an app update/,
  );
});

test("the embedded manifest pins OpenCode with both digests for every packaged platform", () => {
  const platforms = Object.keys(OPENCODE_PACKAGES);
  assert.equal(platforms.length, 8);
  for (const platform of platforms) {
    const asset =
      HARNESS_MANIFEST.opencode.platforms[
        platform as keyof typeof OPENCODE_PACKAGES
      ];
    assert.ok(asset, `OpenCode has no build for ${platform}`);
    assert.match(asset.download.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(asset.binary?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(asset.compression, "gzip");
    assert.equal(asset.archive, "tar");
    assert.ok(asset.url.startsWith("https://registry.npmjs.org/opencode-"));
  }
  assert.ok(HARNESS_MANIFEST.opencode.version.startsWith(opencodeLine()));
});
