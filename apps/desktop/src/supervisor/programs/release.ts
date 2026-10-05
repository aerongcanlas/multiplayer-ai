import type { HarnessId } from "../../shared/tabs";
import { HARNESS_MANIFEST } from "./manifest";
import type { PlatformKey, ProgramAsset } from "./types";

/** One published version of a harness program for this platform, with its publisher's digest. */
export interface ProgramRelease {
  version: string;
  asset: ProgramAsset;
}

const CODEX_TARGETS: Record<PlatformKey, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  // Codex publishes static musl builds for Linux; they serve glibc hosts too.
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64-musl": "aarch64-unknown-linux-musl",
  "linux-x64-musl": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

// OpenCode publishes each platform's binary as its own npm package.
export const OPENCODE_PACKAGES: Record<PlatformKey, string> = {
  "darwin-arm64": "opencode-darwin-arm64",
  "darwin-x64": "opencode-darwin-x64",
  "linux-arm64": "opencode-linux-arm64",
  "linux-x64": "opencode-linux-x64",
  "linux-arm64-musl": "opencode-linux-arm64-musl",
  "linux-x64-musl": "opencode-linux-x64-musl",
  "win32-arm64": "opencode-windows-arm64",
  "win32-x64": "opencode-windows-x64",
};

/** The `major.minor.` prefix in-app OpenCode updates stay within, where its lockdown was verified. */
export const opencodeLine = (pinned = HARNESS_MANIFEST.opencode.version) =>
  `${pinned.split(".").slice(0, 2).join(".")}.`;

const SHA256 = /^[0-9a-f]{64}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

async function json(request: typeof fetch, url: string, accept: string) {
  const response = await request(url, {
    headers: { accept },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 403 || response.status === 429)
    throw new Error(
      "The release lookup is rate limited on this network. Try again in an hour.",
    );
  if (!response.ok)
    throw new Error(`The release lookup failed (HTTP ${response.status}).`);
  return (await response.json()) as Record<string, unknown>;
}

async function codex(
  version: string,
  platform: PlatformKey,
  request: typeof fetch,
): Promise<ProgramAsset> {
  const release = await json(
    request,
    `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`,
    "application/vnd.github+json",
  );
  const name = `codex-package-${CODEX_TARGETS[platform]}.tar.zst`;
  const asset = (Array.isArray(release.assets) ? release.assets : []).find(
    (item: { name?: unknown }) => item?.name === name,
  ) as { digest?: unknown; size?: unknown } | undefined;
  const sha256 =
    typeof asset?.digest === "string"
      ? asset.digest.replace(/^sha256:/, "")
      : "";
  if (!SHA256.test(sha256) || typeof asset?.size !== "number")
    throw new Error(
      `Codex ${version} publishes no verified build for this platform.`,
    );
  return {
    // Built here rather than taken from the response, so the download host is fixed.
    url: `https://github.com/openai/codex/releases/download/rust-v${version}/${name}`,
    file: platform.startsWith("win32") ? "bin/codex.exe" : "bin/codex",
    download: { sha256, size: asset.size },
    compression: "zstd",
    archive: "tar",
  };
}

async function claude(
  version: string,
  platform: PlatformKey,
  request: typeof fetch,
): Promise<ProgramAsset> {
  const manifest = await json(
    request,
    `https://downloads.claude.ai/claude-code-releases/${version}/manifest.json`,
    "application/json",
  );
  const entry = (manifest.platforms as Record<string, unknown> | undefined)?.[
    platform
  ] as { checksum?: unknown; size?: unknown } | undefined;
  if (
    manifest.version !== version ||
    typeof entry?.checksum !== "string" ||
    !SHA256.test(entry.checksum) ||
    typeof entry.size !== "number"
  )
    throw new Error(
      `Claude Code ${version} publishes no verified build for this platform.`,
    );
  const file = platform.startsWith("win32") ? "claude.exe" : "claude";
  return {
    url: `https://downloads.claude.ai/claude-code-releases/${version}/${platform}/${file}`,
    file,
    download: { sha256: entry.checksum, size: entry.size },
  };
}

async function opencode(
  version: string,
  platform: PlatformKey,
  request: typeof fetch,
): Promise<ProgramAsset> {
  const line = opencodeLine();
  if (!version.startsWith(line))
    throw new Error(
      `OpenCode ${version} is available after an app update; this app updates within ${line}x.`,
    );
  const name = OPENCODE_PACKAGES[platform];
  const published = await json(
    request,
    `https://registry.npmjs.org/${name}/${version}`,
    "application/json",
  );
  const integrity = (published.dist as { integrity?: unknown } | undefined)
    ?.integrity;
  if (
    published.version !== version ||
    typeof integrity !== "string" ||
    !SHA512.test(integrity)
  )
    throw new Error(
      `OpenCode ${version} publishes no verified build for this platform.`,
    );
  return {
    // Built here rather than taken from `dist.tarball`, so the download host is fixed.
    url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    file: platform.startsWith("win32")
      ? "package/bin/opencode.exe"
      : "package/bin/opencode",
    download: { integrity },
    compression: "gzip",
    archive: "tar",
  };
}

const LOOKUPS: Record<HarnessId, typeof codex> = { codex, claude, opencode };

/**
 * Where to download a published version and the digest its publisher lists for it. Unlike the
 * embedded manifest, this trusts the publisher's own listing at the time of the update.
 */
export async function findRelease(
  harness: HarnessId,
  version: string,
  platform: PlatformKey,
  request: typeof fetch = fetch,
): Promise<ProgramRelease> {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("That is not a released version.");
  const asset = await LOOKUPS[harness](version, platform, request);
  return { version, asset };
}
