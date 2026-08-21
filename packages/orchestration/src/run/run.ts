import type { RunStatus } from "@multiplayer-ai/domain";
import { resolveModel, type ResolvedRunModel } from "@multiplayer-ai/providers";
import {
  NoOutputGeneratedError,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { buildLead, buildVerifier } from "../agents/lead";
import { resolveProfile } from "../config/profile";
import type { EventSink, RunInput, RunStore } from "./ports";
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
  store: RunStore;
  modelOverride?: LanguageModel;
  abortSignal?: AbortSignal;
};

export async function startRun(
  input: RunInput,
  deps: RunDeps,
): Promise<string> {
  return execute(input, [{ role: "user", content: input.goal }], deps);
}

export async function resumeRun(runId: string, deps: RunDeps): Promise<string> {
  const record = await deps.store.load(runId);
  if (!record) throw new Error(`Unknown run: ${runId}`);
  return execute(
    record.input,
    [
      ...record.messages,
      {
        role: "user",
        content:
          "You were interrupted. Review the transcript above, work out what " +
          "is already done, and continue from there. Do not redo completed work.",
      },
    ],
    deps,
  );
}

async function execute(
  input: RunInput,
  messages: Array<ModelMessage>,
  deps: RunDeps,
): Promise<string> {
  const { sink, store, modelOverride, abortSignal, ...toolDeps } = deps;
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

  const persist = (
    next: Array<ModelMessage>,
    status: RunStatus,
  ): Promise<void> => store.save({ input, messages: next, status });

  const lead = buildLead(resolved.model, context, resolved.providerOptions);

  const streamRound = async (roundMessages: Array<ModelMessage>) => {
    const result = await lead.stream({
      messages: roundMessages,
      abortSignal: controller.signal,
    });
    if (sink.merge) {
      sink.merge(
        toUIMessageStream({
          stream: result.stream,
          sendReasoning: true,
          sendStart: false,
          sendFinish: false,
        }),
      );
    }
    const responseMessages = await result.responseMessages;
    const text = await result.text;
    return { responseMessages, text };
  };

  let transcript: Array<ModelMessage> = messages;

  try {
    let round = await streamRound(messages);
    transcript = [...messages, ...round.responseMessages];
    await persist(transcript, "running");

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
          ...transcript,
          {
            role: "user",
            content:
              "Verification failed. Fix these, then report again:\n" +
              verdict.issues.map((i) => `- ${i}`).join("\n"),
          },
        ];
        round = await streamRound(followUp);
        transcript = [...followUp, ...round.responseMessages];
      }
    }

    if (round.text.trim().length === 0) {
      await sink.emit({
        kind: "run.no_action",
        runId: input.runId,
        reason: "The lead produced no report.",
      });
    }

    await persist(transcript, "finished");
    await sink.emit({
      kind: "run.finished",
      runId: input.runId,
      text: round.text,
    });
    return round.text;
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
    await persist(transcript, aborted ? "cancelled" : "failed");
    throw error;
  } finally {
    inFlight.delete(input.runId);
  }
}
