import type { HarnessId } from "../../shared/tabs";

export type PlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "linux-arm64-musl"
  | "linux-x64-musl"
  | "win32-arm64"
  | "win32-x64";

export interface Digest {
  sha256: string;
  size: number;
}
// An update from npm lists only the package's sha512 `integrity`, so its size is unknown upfront.
export type DownloadDigest =
  | Digest
  | { integrity: string; sha256?: undefined; size?: number };
export interface ProgramAsset {
  url: string;
  // The executable's path once stored; inside the unpacked folder for an archive.
  file: string;
  // The downloaded file.
  download: DownloadDigest;
  compression?: "zstd" | "gzip";
  // A tar package unpacked into the version folder (the executable needs its companion files).
  archive?: "tar";
  // The decompressed executable; equal to `download` when uncompressed.
  binary?: Digest;
}
export type ProgramManifest = Record<
  HarnessId,
  { version: string; platforms: Partial<Record<PlatformKey, ProgramAsset>> }
>;
