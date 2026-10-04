import { z } from "zod";
import type { SupervisorRequest } from "../shared/contracts";
import {
  harnessIdSchema,
  transcriptEntrySchema,
  type HarnessId,
  type TranscriptBatch,
} from "../shared/tabs";

const batchesSchema = z
  .array(
    z
      .object({
        roomId: z.uuid(),
        tabId: z.uuid(),
        entries: z.array(transcriptEntrySchema).max(1_000),
      })
      .strict(),
  )
  .max(200);

/** Transcript batches from the supervisor, or null when their shape is unknown. */
export function parseTranscript(value: unknown): TranscriptBatch[] | null {
  const parsed = batchesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Hosts main may open for each harness's in-app sign-in. Claude Code offers none.
const LOGIN_HOSTS: Record<HarnessId, string[]> = {
  codex: ["auth.openai.com", "chatgpt.com"],
  claude: [],
  opencode: [],
};

export function loginAllowed(harness: unknown, value: string): boolean {
  const id = harnessIdSchema.safeParse(harness);
  if (!id.success) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      LOGIN_HOSTS[id.data].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Harness commands may wait on a program download; tab commands return when work starts. */
export function requestTimeout(type: SupervisorRequest["command"]["type"]) {
  return type === "suggestion.create"
    ? 180_000
    : type.startsWith("harness.")
      ? 90_000
      : 20_000;
}
