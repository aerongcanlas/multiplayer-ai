import type { HarnessId } from "../../shared/tabs";

const PACKAGES: Record<HarnessId, string> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
};

/**
 * The newest published version of a harness program, read from the npm registry. Only the
 * version number is used; managed programs still come from the pinned, checksummed manifest.
 */
export async function latestVersion(
  harness: HarnessId,
  request: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await request(
      `https://registry.npmjs.org/${PACKAGES[harness]}/latest`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const version = ((await response.json()) as { version?: unknown }).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
      ? version
      : null;
  } catch {
    return null;
  }
}
