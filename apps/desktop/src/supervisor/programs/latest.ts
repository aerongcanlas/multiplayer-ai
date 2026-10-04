import type { HarnessId } from "../../shared/tabs";
import { HARNESS_MANIFEST } from "./manifest";
import { opencodeLine } from "./release";

const PACKAGES: Record<HarnessId, string> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
};
const RELEASE = /^\d+\.\d+\.\d+$/;

/** The newest version the app can move to, and a newer one that needs an app update first. */
export interface LatestRelease {
  version: string;
  later?: string;
}

async function published(request: typeof fetch, name: string, tag: string) {
  try {
    const response = await request(
      `https://registry.npmjs.org/${name}/${tag}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const version = ((await response.json()) as { version?: unknown }).version;
    return typeof version === "string" && RELEASE.test(version)
      ? version
      : null;
  } catch {
    return null;
  }
}

/**
 * The newest OpenCode patch within the pinned minor line. The registry lists versions only in a
 * multi-megabyte document, so patches are probed one by one: doubling, then bisecting.
 */
async function newestInLine(request: typeof fetch, line: string, from: number) {
  const exists = async (patch: number) =>
    (await published(request, PACKAGES.opencode, `${line}${patch}`)) ===
    `${line}${patch}`;
  let low = from;
  let step = 1;
  while (step <= 1024 && (await exists(low + step))) {
    low += step;
    step *= 2;
  }
  let high = low + step;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await exists(middle)) low = middle;
    else high = middle;
  }
  return `${line}${low}`;
}

/**
 * The newest published version of a harness program, read from the npm registry. Only the
 * version number is used; managed programs still come from the pinned, checksummed manifest.
 * OpenCode updates stay within the pinned minor line.
 */
export async function latestVersion(
  harness: HarnessId,
  request: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  const latest = await published(request, PACKAGES[harness], "latest");
  if (!latest) return null;
  if (harness !== "opencode") return { version: latest };
  const line = opencodeLine();
  if (latest.startsWith(line)) return { version: latest };
  const pinned = HARNESS_MANIFEST.opencode.version;
  const version = await newestInLine(
    request,
    line,
    Number(pinned.slice(line.length)),
  );
  return { version, later: latest };
}
