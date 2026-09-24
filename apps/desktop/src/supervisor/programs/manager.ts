import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, createWriteStream, constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createZstdDecompress } from "node:zlib";
import { extractTar } from "./tar";
import type { HarnessId } from "../../shared/tabs";
import type {
  Digest,
  PlatformKey,
  ProgramAsset,
  ProgramManifest,
} from "./types";

export type ProgramErrorCode =
  | "checksum_mismatch"
  | "network"
  | "disk_full"
  | "unsupported_platform"
  | "custom_invalid";

export class ProgramError extends Error {
  constructor(
    readonly code: ProgramErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedProgram {
  path: string;
  source: "managed" | "custom";
  // The pinned version for managed programs; custom programs report theirs in the handshake.
  version: string | null;
}
export interface ProgramProgress {
  harness: HarnessId;
  received: number;
  total: number;
}
interface Meta extends Digest {
  harness: HarnessId;
  version: string;
  platform: PlatformKey;
  url: string;
  verifiedAt: string;
}

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = platform === "linux" && isMusl(),
): PlatformKey | null {
  if (arch !== "arm64" && arch !== "x64") return null;
  if (platform === "darwin" || platform === "win32")
    return `${platform}-${arch}`;
  if (platform === "linux")
    return musl ? `linux-${arch}-musl` : `linux-${arch}`;
  return null;
}

function isMusl() {
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

const hashing = (
  digest: ReturnType<typeof createHash>,
  onBytes: (count: number) => void,
) =>
  new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });

async function fileDigest(path: string): Promise<Digest> {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: digest.digest("hex"), size };
}

const classify = (error: unknown, fallback: string): ProgramError => {
  if (error instanceof ProgramError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC")
    return new ProgramError(
      "disk_full",
      "There is not enough disk space to store the harness program.",
    );
  return new ProgramError("network", fallback);
};

/**
 * Downloads pinned harness programs into app data, verifies them against the embedded manifest,
 * and resolves custom executables. It knows nothing about harness protocols.
 */
export class ProgramManager extends EventEmitter {
  private jobs = new Map<HarnessId, Promise<ResolvedProgram>>();
  private readonly fetch: typeof fetch;
  private readonly writer: (path: string) => Writable;

  constructor(
    private options: {
      root: string;
      manifest: ProgramManifest;
      platform?: PlatformKey | null;
      fetch?: typeof fetch;
      createWriteStream?: (path: string) => Writable;
      timeoutMs?: number;
    },
  ) {
    super();
    this.fetch = options.fetch ?? fetch;
    this.writer =
      options.createWriteStream ?? ((path) => createWriteStream(path));
  }

  pinned(harness: HarnessId) {
    return this.options.manifest[harness].version;
  }

  private asset(harness: HarnessId): {
    platform: PlatformKey;
    asset: ProgramAsset;
  } {
    const platform =
      this.options.platform === undefined
        ? detectPlatform()
        : this.options.platform;
    const asset =
      platform && this.options.manifest[harness].platforms[platform];
    if (!platform || !asset)
      throw new ProgramError(
        "unsupported_platform",
        "No managed build of this harness exists for this platform. Choose a custom executable in Harness settings.",
      );
    return { platform, asset };
  }

  private folder(harness: HarnessId) {
    return join(this.options.root, "harnesses", harness, this.pinned(harness));
  }

  private location(harness: HarnessId, asset: ProgramAsset) {
    return join(this.folder(harness), ...asset.file.split("/"));
  }

  /** Whether a verified managed program is already stored, without downloading. */
  async installed(harness: HarnessId): Promise<boolean> {
    try {
      const { asset } = this.asset(harness);
      return await this.verified(this.location(harness, asset), asset);
    } catch {
      return false;
    }
  }

  /** Returns the custom path, the verified managed path, or downloads the pinned program. */
  resolve(
    harness: HarnessId,
    customPath?: string | null,
  ): Promise<ResolvedProgram> {
    if (customPath) return this.custom(customPath);
    const running = this.jobs.get(harness);
    if (running) return running;
    const job = this.acquire(harness).finally(() => this.jobs.delete(harness));
    this.jobs.set(harness, job);
    return job;
  }

  private async custom(path: string): Promise<ResolvedProgram> {
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error();
      if (process.platform !== "win32") await access(path, constants.X_OK);
    } catch {
      throw new ProgramError(
        "custom_invalid",
        "The custom executable is missing or cannot be run. Choose another file or switch back to the managed program.",
      );
    }
    return { path, source: "custom", version: null };
  }

  private async verified(path: string, asset: ProgramAsset): Promise<boolean> {
    const expected = asset.binary ?? asset.download;
    let meta: Meta | undefined;
    try {
      meta = JSON.parse(await readFile(`${path}.meta`, "utf8")) as Meta;
    } catch {
      meta = undefined;
    }
    try {
      const info = await stat(path);
      if (meta?.sha256 === expected.sha256 && info.size === expected.size)
        return true;
    } catch {
      return false;
    }
    // A file without a matching record is untrusted (for example after a crash mid-rename).
    const actual = await fileDigest(path);
    return actual.sha256 === expected.sha256 && actual.size === expected.size;
  }

  private async acquire(harness: HarnessId): Promise<ResolvedProgram> {
    const { platform, asset } = this.asset(harness);
    const target = this.location(harness, asset);
    const version = this.pinned(harness);
    if (await this.verified(target, asset)) {
      await this.writeMeta(target, harness, platform, asset);
      return { path: target, source: "managed", version };
    }
    if (asset.archive === "tar")
      return this.acquireArchive(harness, platform, asset, target, version);
    await rm(target, { force: true });
    await rm(`${target}.meta`, { force: true });
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    const unpacked = `${target}.unpacked`;
    try {
      await this.download(harness, asset, partial);
      const binary = asset.binary ?? asset.download;
      if (asset.compression === "zstd") {
        const digest = createHash("sha256");
        let size = 0;
        try {
          await pipeline(
            createReadStream(partial),
            createZstdDecompress(),
            hashing(digest, (count) => (size += count)),
            this.writer(unpacked),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw error;
          throw new ProgramError(
            "checksum_mismatch",
            "The downloaded harness program is corrupt.",
          );
        }
        if (digest.digest("hex") !== binary.sha256 || size !== binary.size)
          throw new ProgramError(
            "checksum_mismatch",
            "The unpacked harness program does not match its pinned checksum.",
          );
        await rm(partial, { force: true });
      } else await rename(partial, unpacked);
      if (process.platform !== "win32") await chmod(unpacked, 0o755);
      await rename(unpacked, target);
      await this.writeMeta(target, harness, platform, asset);
      return { path: target, source: "managed", version };
    } catch (error) {
      await rm(partial, { force: true });
      await rm(unpacked, { force: true });
      throw classify(
        error,
        "The harness program could not be downloaded. Check your connection and retry.",
      );
    }
  }

  /** Unpacks a verified package into a staging folder, checks the executable, then swaps it in. */
  private async acquireArchive(
    harness: HarnessId,
    platform: PlatformKey,
    asset: ProgramAsset,
    target: string,
    version: string,
  ): Promise<ResolvedProgram> {
    const folder = this.folder(harness);
    const partial = `${folder}.partial`;
    const staging = `${folder}.unpacked`;
    await mkdir(dirname(folder), { recursive: true });
    await rm(staging, { recursive: true, force: true });
    try {
      await this.download(harness, asset, partial);
      await mkdir(staging, { recursive: true });
      try {
        if (asset.compression === "zstd")
          await pipeline(
            createReadStream(partial),
            createZstdDecompress(),
            extractTar(staging),
          );
        else await pipeline(createReadStream(partial), extractTar(staging));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw error;
        throw new ProgramError(
          "checksum_mismatch",
          `The downloaded harness package could not be unpacked. ${error instanceof Error ? error.message : ""}`.trim(),
        );
      }
      const binary = asset.binary ?? asset.download;
      const actual = await fileDigest(
        join(staging, ...asset.file.split("/")),
      ).catch(() => ({ sha256: "", size: -1 }));
      if (actual.sha256 !== binary.sha256 || actual.size !== binary.size)
        throw new ProgramError(
          "checksum_mismatch",
          "The unpacked harness program does not match its pinned checksum.",
        );
      await rm(partial, { force: true });
      await rm(folder, { recursive: true, force: true });
      await rename(staging, folder);
      await this.writeMeta(target, harness, platform, asset);
      return { path: target, source: "managed", version };
    } catch (error) {
      await rm(partial, { force: true });
      await rm(staging, { recursive: true, force: true });
      throw classify(
        error,
        "The harness program could not be downloaded. Check your connection and retry.",
      );
    }
  }

  private async download(
    harness: HarnessId,
    asset: ProgramAsset,
    partial: string,
  ) {
    const response = await this.fetch(asset.url, {
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20 * 60_000),
      redirect: "follow",
    });
    if (!response.ok || !response.body)
      throw new ProgramError(
        "network",
        `The harness download failed (HTTP ${response.status}). Retry in a moment.`,
      );
    const digest = createHash("sha256");
    let received = 0;
    const total = asset.download.size;
    let reported = 0;
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      hashing(digest, (count) => {
        received += count;
        // Report about every 1% so a large download does not flood snapshots.
        if (received - reported >= total / 100 || received === total) {
          reported = received;
          this.emit("progress", {
            harness,
            received,
            total,
          } satisfies ProgramProgress);
        }
      }),
      this.writer(partial),
    );
    if (
      digest.digest("hex") !== asset.download.sha256 ||
      received !== asset.download.size
    )
      throw new ProgramError(
        "checksum_mismatch",
        "The downloaded harness program does not match its pinned checksum. It was deleted.",
      );
  }

  private async writeMeta(
    target: string,
    harness: HarnessId,
    platform: PlatformKey,
    asset: ProgramAsset,
  ) {
    const digest = asset.binary ?? asset.download;
    const meta: Meta = {
      harness,
      version: this.pinned(harness),
      platform,
      url: asset.url,
      ...digest,
      verifiedAt: new Date().toISOString(),
    };
    await writeFile(`${target}.meta.partial`, JSON.stringify(meta));
    await rename(`${target}.meta.partial`, `${target}.meta`);
  }
}
