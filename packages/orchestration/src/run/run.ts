import type { RunMessageMetadata, RunUIMessage } from "@multiplayer-ai/domain";
import { resolveModel, type ResolvedRunModel } from "@multiplayer-ai/providers";
import { APICallError } from "@ai-sdk/provider";
import {
  NoOutputGeneratedError,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { buildLead, buildVerifier } from "../agents/lead";
import { resolveProfile } from "../config/profile";
import { attributeAuthors } from "./authorship";
import { buildReplay } from "./replay";
import type { EventSink, RunInput } from "./ports";
import type { ToolDeps } from "../tools";

const inFlight = new Map<string, AbortController>();

export function cancelRun(runId: string): boolean {
  const controller = inFlight.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export type RunDeps = Omit<
  ToolDeps,
  "runId" | "roomId" | "sink" | "profile"
> & {
  sink: EventSink;
  modelOverride?: LanguageModel;
  abortSignal?: AbortSignal;
};

function isContextLengthError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode !== 400) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("context length") ||
    message.includes("context_length") ||
    message.includes("maximum context") ||
    message.includes("token count") ||
    message.includes("too many tokens") ||
    message.includes("exceeds the maximum number of tokens")
  );
}

export async function runTurn(
  input: RunInput,
  seedMessages: Array<RunUIMessage>,
  deps: RunDeps,
): Promise<void> {
  const { sink, modelOverride, abortSignal, ...toolDeps } = deps;
  const resolved: ResolvedRunModel = modelOverride
    ? { model: modelOverride }
    : resolveModel(input.model);
  const profile = resolveProfile(input.effort);

  const controller = new AbortController();
  if (abortSignal?.aborted) controller.abort(abortSignal.reason);
  abortSignal?.addEventListener(
    "abort",
    () => controller.abort(abortSignal.reason),
    { once: true },
  );
  inFlight.set(input.runId, controller);

  const context: ToolDeps = {
    ...toolDeps,
    runId: input.runId,
    roomId: input.roomId,
    sink,
    profile,
  };

  await sink.emit({
    kind: "run.started",
    runId: input.runId,
    goal: input.goal,
    model: input.model,
  });

  const lead = buildLead(resolved.model, context, resolved.providerOptions);

  let compactionAnnounced = false;
  const announceCompaction = async (compacted: boolean) => {
    if (compacted && !compactionAnnounced) {
      compactionAnnounced = true;
      await sink.emit({ kind: "run.compacted", runId: input.runId });
    }
  };

  const streamRound = async (roundMessages: Array<ModelMessage>) => {
    const result = await lead.stream({
      messages: roundMessages,
      abortSignal: controller.signal,
    });
    let streamError: unknown;
    if (sink.merge) {
      sink.merge(
        toUIMessageStream({
          stream: result.stream,
          sendReasoning: true,
          sendStart: false,
          sendFinish: false,
          onError: (error) => {
            streamError = error;
            return "Run stream error";
          },
        }),
      );
    }
    try {
      const responseMessages = await result.responseMessages;
      const text = await result.text;
      const finalStep = await result.finalStep;
      if (finalStep.usage.inputTokens !== undefined) {
        sink.setMessageMetadata?.({
          usage: {
            inputTokens: finalStep.usage.inputTokens,
            model: input.model,
          },
        } satisfies RunMessageMetadata);
      }
      return { responseMessages, text };
    } catch (error) {
      throw streamError ?? error;
    }
  };

  try {
    const thread = attributeAuthors(seedMessages);
    const initialReplay = await buildReplay(thread, input.model);
    await announceCompaction(initialReplay.compacted);

    let round;
    try {
      round = await streamRound(initialReplay.modelMessages);
    } catch (error) {
      if (!isContextLengthError(error)) throw error;
      const hardReplay = await buildReplay(thread, input.model, "hard");
      await announceCompaction(hardReplay.compacted);
      round = await streamRound(hardReplay.modelMessages);
    }

    let working: Array<ModelMessage> = [
      ...initialReplay.modelMessages,
      ...round.responseMessages,
    ];

    if (profile.verificationPass) {
      const verifier = buildVerifier(resolved.model);
      let verdict: { ok: boolean; issues: Array<string> };
      try {
        const verifierResult = await verifier.generate({
          prompt: `Goal: ${input.goal}\n\nReport:\n${round.text}`,
          abortSignal: controller.signal,
        });
        verdict = verifierResult.output;
      } catch (error) {
        if (
          controller.signal.aborted ||
          !NoOutputGeneratedError.isInstance(error)
        ) {
          throw error;
        }
        verdict = { ok: false, issues: [] };
      }

      await sink.emit({
        kind: "run.verify",
        runId: input.runId,
        ok: verdict.ok,
        issues: verdict.issues,
      });

      if (!verdict.ok && verdict.issues.length > 0) {
        const followUp: Array<ModelMessage> = [
          ...working,
          {
            role: "user",
            content:
              "Verification failed. Fix these, then report again:\n" +
              verdict.issues.map((i) => `- ${i}`).join("\n"),
          },
        ];
        round = await streamRound(followUp);
        working = [...followUp, ...round.responseMessages];
      }
    }

    if (round.text.trim().length === 0) {
      await sink.emit({
        kind: "run.no_action",
        runId: input.runId,
        reason: "The lead produced no report.",
      });
    }

    await sink.emit({
      kind: "run.finished",
      runId: input.runId,
      text: round.text,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    await sink.emit(
      aborted
        ? { kind: "run.cancelled", runId: input.runId }
        : {
            kind: "run.failed",
            runId: input.runId,
            error: error instanceof Error ? error.message : String(error),
          },
    );
    throw error;
  } finally {
    inFlight.delete(input.runId);
  }
}
