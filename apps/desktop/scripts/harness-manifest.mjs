// Maintainer script: regenerates the embedded harness program manifest when pins move.
//   node scripts/harness-manifest.mjs            writes src/supervisor/programs/manifest.ts
//   node scripts/harness-manifest.mjs --print    prints the digests instead
//   node scripts/harness-manifest.mjs --check    fails when a pin is behind the newest release
//   node scripts/harness-manifest.mjs --only=opencode  re-pins one harness, keeping the others' entries
// Codex comes from the release's per-platform `codex-package` archive, because the codex binary
// needs its companions (codex-code-mode-host, rg) beside it. Digests come from the GitHub release
// (trust on first use); the executable's digest is computed by downloading and unpacking each one. Claude Code digests come from the manifest.json
// shipped in the paired Claude Agent SDK package. OpenCode comes from npm's per-platform packages:
// each tarball is checked against npm's sha512 integrity, then its sha256 and the unpacked
// binary's sha256 are recorded.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const CODEX_VERSION = "0.160.0";
const SDK_VERSION = "0.3.286";
const CLAUDE_VERSION = "2.1.286";
// In-app OpenCode updates stay within this minor line; re-verify the lockdown before moving it.
const OPENCODE_VERSION = "1.18.34";
const print = process.argv.includes("--print");

if (process.argv.includes("--check")) {
  const newest = async (name) =>
    (await (await fetch(`https://registry.npmjs.org/${name}/latest`)).json())
      .version;
  const pins = [
    ["Codex", CODEX_VERSION, await newest("@openai/codex")],
    ["Claude Code", CLAUDE_VERSION, await newest("@anthropic-ai/claude-code")],
    [
      "Claude Agent SDK",
      SDK_VERSION,
      await newest("@anthropic-ai/claude-agent-sdk"),
    ],
    ["OpenCode", OPENCODE_VERSION, await newest("opencode-ai")],
  ];
  const behind = pins.filter(([, pinned, latest]) => pinned !== latest);
  for (const [name, pinned, latest] of pins)
    console.log(`${name}: pinned ${pinned}, newest ${latest}`);
  process.exit(behind.length ? 1 : 0);
}

const codexTargets = {
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

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function codex() {
  const release = await (
    await fetch(
      `https://api.github.com/repos/openai/codex/releases/tags/rust-v${CODEX_VERSION}`,
      { headers: { accept: "application/vnd.github+json" } },
    )
  ).json();
  const platforms = {};
  const unpacked = new Map();
  for (const [platform, target] of Object.entries(codexTargets)) {
    const name = `codex-package-${target}.tar.zst`;
    const asset = release.assets?.find((item) => item.name === name);
    if (!asset?.digest?.startsWith("sha256:"))
      throw new Error(
        `Codex ${CODEX_VERSION} has no published digest for ${name}.`,
      );
    const digest = asset.digest.slice("sha256:".length);
    if (!unpacked.has(name)) {
      const compressed = await download(asset.browser_download_url);
      if (sha256(compressed) !== digest)
        throw new Error(`${name} does not match its published digest.`);
      const archive = zstdDecompressSync(compressed);
      const entries = tarEntries(archive);
      const file = [...entries.keys()].find((entry) =>
        /^bin\/codex(\.exe)?$/.test(entry),
      );
      if (!file) throw new Error(`${name} has no bin/codex executable.`);
      const binary = entries.get(file);
      unpacked.set(name, {
        file,
        binary: { sha256: sha256(binary), size: binary.length },
      });
      console.error(
        `${name}: ${[...entries.keys()].filter((entry) => entry.startsWith("bin/")).join(", ")}`,
      );
    }
    const { file, binary } = unpacked.get(name);
    platforms[platform] = {
      url: asset.browser_download_url,
      file,
      download: { sha256: digest, size: asset.size },
      compression: "zstd",
      archive: "tar",
      binary,
    };
  }
  return { version: CODEX_VERSION, platforms };
}

// Lists the regular files in a tar archive, honoring ustar prefixes and pax paths.
function tarEntries(archive) {
  const files = new Map();
  let pax;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) =>
      header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const size = parseInt(text(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    const prefix = text(345, 155);
    const name = pax ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    if (type === "x")
      pax = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
    else {
      pax = undefined;
      if (type === "0") files.set(name.replace(/^\.\//, ""), body);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const opencodePackages = {
  "darwin-arm64": "opencode-darwin-arm64",
  "darwin-x64": "opencode-darwin-x64",
  "linux-arm64": "opencode-linux-arm64",
  "linux-x64": "opencode-linux-x64",
  "linux-arm64-musl": "opencode-linux-arm64-musl",
  "linux-x64-musl": "opencode-linux-x64-musl",
  "win32-arm64": "opencode-windows-arm64",
  "win32-x64": "opencode-windows-x64",
};

async function opencodePlatform(platform, name) {
  const published = await (
    await fetch(`https://registry.npmjs.org/${name}/${OPENCODE_VERSION}`)
  ).json();
  const integrity = published.dist?.integrity;
  if (!/^sha512-/.test(integrity ?? ""))
    throw new Error(`${name}@${OPENCODE_VERSION} has no sha512 integrity.`);
  const url = `https://registry.npmjs.org/${name}/-/${name}-${OPENCODE_VERSION}.tgz`;
  const tarball = await download(url);
  if (
    `sha512-${createHash("sha512").update(tarball).digest("base64")}` !==
    integrity
  )
    throw new Error(`${name} does not match its npm integrity.`);
  const entries = tarEntries(gunzipSync(tarball));
  const file = platform.startsWith("win32")
    ? "package/bin/opencode.exe"
    : "package/bin/opencode";
  const binary = entries.get(file);
  if (!binary)
    throw new Error(
      `${name} has no ${file}; it holds ${[...entries.keys()].join(", ")}.`,
    );
  console.error(`${name}: ${file} ${binary.length} bytes`);
  return {
    url,
    file,
    download: { sha256: sha256(tarball), size: tarball.length },
    compression: "gzip",
    archive: "tar",
    binary: { sha256: sha256(binary), size: binary.length },
  };
}

// The per-platform packages are independent, so they download together.
async function opencode() {
  const platforms = Object.fromEntries(
    await Promise.all(
      Object.entries(opencodePackages).map(async ([platform, name]) => [
        platform,
        await opencodePlatform(platform, name),
      ]),
    ),
  );
  return { version: OPENCODE_VERSION, platforms };
}

async function claude() {
  const tarball = gunzipSync(
    await download(
      `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-${SDK_VERSION}.tgz`,
    ),
  );
  const manifest = JSON.parse(
    tarEntries(tarball).get("package/manifest.json").toString("utf8"),
  );
  if (manifest.version !== CLAUDE_VERSION)
    throw new Error(
      `SDK ${SDK_VERSION} pairs Claude Code ${manifest.version}, not ${CLAUDE_VERSION}.`,
    );
  const platforms = {};
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!/^[0-9a-f]{64}$/.test(entry.checksum))
      throw new Error(
        `Claude Code ${CLAUDE_VERSION} has no checksum for ${platform}.`,
      );
    platforms[platform] = {
      url: `https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${platform}/${entry.binary}`,
      file: entry.binary,
      download: { sha256: entry.checksum, size: entry.size },
    };
  }
  return { version: CLAUDE_VERSION, platforms };
}

const target = fileURLToPath(
  new URL("../src/supervisor/programs/manifest.ts", import.meta.url),
);
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const pins = { codex, claude, opencode };
let manifest;
if (only) {
  if (!pins[only]) throw new Error(`Unknown harness ${only}.`);
  // The generated file is one object literal (prettier unquotes its keys, so it is not JSON);
  // the other harnesses keep their entries.
  const source = await readFile(target, "utf8");
  const literal = source.slice(
    source.indexOf("= ", source.indexOf("HARNESS_MANIFEST")) + 2,
    source.lastIndexOf(";"),
  );
  manifest = runInNewContext(`(${literal})`);
  manifest[only] = await pins[only]();
} else
  manifest = {
    codex: await codex(),
    claude: await claude(),
    opencode: await opencode(),
  };
if (print) console.log(JSON.stringify(manifest, null, 2));
else {
  await writeFile(
    target,
    `// Generated by scripts/harness-manifest.mjs. Do not edit by hand; rerun the script when pins move.
import type { ProgramManifest } from "./types";

export const HARNESS_MANIFEST: ProgramManifest = ${JSON.stringify(manifest, null, 2)};
`,
  );
  console.log(`Wrote ${target}`);
}
