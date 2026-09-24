import type { HarnessId } from "../../shared/tabs";

export const PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "win32-arm64",
  "win32-x64",
] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export interface Digest {
  sha256: string;
  size: number;
}
export interface ProgramAsset {
  url: string;
  // The executable's file name once stored.
  file: string;
  // The downloaded file.
  download: Digest;
  compression?: "zstd";
  // The decompressed executable; equal to `download` when uncompressed.
  binary?: Digest;
}
export type ProgramManifest = Record<
  HarnessId,
  { version: string; platforms: Partial<Record<PlatformKey, ProgramAsset>> }
>;
