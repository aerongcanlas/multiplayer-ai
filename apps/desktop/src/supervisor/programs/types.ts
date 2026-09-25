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
export interface ProgramAsset {
  url: string;
  // The executable's path once stored; inside the unpacked folder for an archive.
  file: string;
  // The downloaded file.
  download: Digest;
  compression?: "zstd";
  // A tar package unpacked into the version folder (the executable needs its companion files).
  archive?: "tar";
  // The decompressed executable; equal to `download` when uncompressed.
  binary?: Digest;
}
export type ProgramManifest = Record<
  HarnessId,
  { version: string; platforms: Partial<Record<PlatformKey, ProgramAsset>> }
>;
