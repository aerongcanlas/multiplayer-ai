import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeOptions, ClaudeQuery } from "./adapter";
import type { AuthStatus } from "./auth";

// A scripted Claude Agent SDK query for tests and MP_E2E only. It never starts Claude Code or
// makes network requests. Prompt markers select behavior: FIXTURE_ASK (an AskUserQuestion call),
// FIXTURE_BASH (a Bash tool call), FIXTURE_EXIT_PLAN (an ExitPlanMode call in plan mode),
// FIXTURE_USAGE (a usage limit), FIXTURE_SLOW (waits for an interrupt), and FIXTURE_CRASH.
// Sessions persist in the state file so a restarted app can resume them.

export interface FixtureState {
  signedIn: boolean;
  sessions: Record<string, number>;
}

export interface FixtureRecord {
  options: Options[];
  calls: string[];
}

const message = (value: Record<string, unknown>) =>
  value as unknown as SDKMessage;

export function claudeFixture(
  statePath?: string,
  initial?: Partial<FixtureState>,
) {
  let memory: FixtureState = { signedIn: true, sessions: {}, ...initial };
  const load = (): FixtureState =>
    statePath && existsSync(statePath)
      ? {
          signedIn: true,
          sessions: {},
          ...JSON.parse(readFileSync(statePath, "utf8")),
        }
      : memory;
  const save = (state: FixtureState) => {
    memory = state;
    if (statePath) writeFileSync(statePath, JSON.stringify(state));
  };
  const record: FixtureRecord = { options: [], calls: [] };

  const authStatus = async (): Promise<AuthStatus> => ({
    loggedIn: load().signedIn,
    ...(load().signedIn
      ? { email: "fixture@example.invalid", subscription: "max" }
      : {}),
    version: "2.1.280",
  });

  const startQuery = (params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }): ClaudeQuery => {
    const { options } = params;
    record.options.push(options);
    let mode = options.permissionMode ?? "default";
    let model = options.model ?? "default";
    let interrupted: (() => void) | undefined;
    let closed = false;
    const resumed = options.resume;
    const sessionId = resumed ?? randomUUID();
    const tool = (name: string, input: Record<string, unknown>) =>
      options.canUseTool!(name, input, {
        signal: new AbortController().signal,
        toolUseID: randomUUID(),
        requestId: randomUUID(),
      }) as Promise<PermissionResult>;

    async function* run(): AsyncGenerator<SDKMessage> {
      if (resumed && !(resumed in load().sessions))
        throw new Error(`No conversation found with session ID: ${resumed}`);
      for await (const input of params.prompt) {
        if (closed) return;
        const prompt = String(input.message.content);
        record.calls.push(`prompt:${prompt}`);
        yield message({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          model,
        });
        const turns = load().sessions[sessionId] ?? 0;
        const reply: string[] = [];
        let failed: string | undefined;
        if (prompt.includes("FIXTURE_CRASH"))
          throw new Error("Claude Code exited with code 1");
        if (prompt.includes("FIXTURE_SLOW"))
          await new Promise<void>((resolve) => (interrupted = resolve));
        if (prompt.includes("FIXTURE_USAGE")) {
          yield message({
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", resetsAt: 2_000_000_000 },
            session_id: sessionId,
          });
          failed = "Claude usage limit reached.";
        }
        if (prompt.includes("FIXTURE_ASK")) {
          const result = await tool("AskUserQuestion", {
            questions: [
              {
                question: "Which approach should the skill take?",
                header: "Approach",
                multiSelect: false,
                options: [
                  { label: "Fast", description: "Ship quickly" },
                  { label: "Thorough", description: "Cover edge cases" },
                ],
              },
            ],
          });
          record.calls.push(`ask:${JSON.stringify(result)}`);
          if (result.behavior === "allow")
            reply.push(
              `Skill continues with ${JSON.stringify((result.updatedInput as { answers?: unknown }).answers)}.`,
            );
        }
        if (prompt.includes("FIXTURE_BASH")) {
          const id = randomUUID();
          const input = { command: "ls -la", description: "List files" };
          const result = await tool("Bash", input);
          record.calls.push(`bash:${result.behavior}`);
          yield message({
            type: "assistant",
            message: {
              id: randomUUID(),
              content: [{ type: "tool_use", id, name: "Bash", input }],
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
          yield message({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: id,
                  content: result.behavior === "allow" ? "README.md" : "Denied",
                  is_error: result.behavior !== "allow",
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
        }
        if (mode === "plan") {
          const plan = "1. Read the code\n2. Make the change";
          if (prompt.includes("FIXTURE_EXIT_PLAN")) {
            const result = await tool("ExitPlanMode", { plan });
            record.calls.push(`exit-plan:${result.behavior}:${mode}`);
            reply.push(
              result.behavior === "allow"
                ? "Implementing the plan."
                : "Still planning.",
            );
          } else reply.push(plan);
        }
        if (!interrupted && !reply.length && !failed)
          reply.push(
            `Claude fixture reply (previous turns: ${turns}) with ${model}.`,
          );
        const id = `msg_${randomUUID()}`;
        const text = reply.join(" ");
        if (text) {
          yield message({
            type: "stream_event",
            event: { type: "message_start", message: { id } },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
          yield message({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: text.slice(0, 5) },
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
          yield message({
            type: "assistant",
            message: { id, content: [{ type: "text", text }] },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
        }
        const state = load();
        save({
          ...state,
          sessions: { ...state.sessions, [sessionId]: turns + 1 },
        });
        yield message(
          failed
            ? {
                type: "result",
                subtype: "success",
                is_error: true,
                result: failed,
                session_id: sessionId,
              }
            : interrupted
              ? {
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  errors: ["Interrupted"],
                  session_id: sessionId,
                }
              : {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  result: text,
                  session_id: sessionId,
                },
        );
        interrupted = undefined;
      }
    }

    const iterator = run();
    return {
      [Symbol.asyncIterator]: () => iterator,
      accountInfo: async () => ({
        email: "fixture@example.invalid",
        subscriptionType: "max",
      }),
      supportedModels: async () => [
        {
          value: "default",
          displayName: "Default (recommended)",
          description: "",
          supportedEffortLevels: ["low", "medium", "high"],
        },
        { value: "haiku", displayName: "Haiku", description: "" },
      ],
      interrupt: async () => {
        record.calls.push("interrupt");
        interrupted?.();
      },
      setPermissionMode: async (next) => {
        record.calls.push(`mode:${next}`);
        mode = next;
      },
      setModel: async (next) => {
        record.calls.push(`model:${next}`);
        model = next ?? "default";
      },
      applyFlagSettings: async (settings) => {
        record.calls.push(`flags:${JSON.stringify(settings)}`);
      },
      close: () => {
        record.calls.push("close");
        closed = true;
        interrupted?.();
      },
    };
  };

  return {
    record,
    setSignedIn: (signedIn: boolean) => save({ ...load(), signedIn }),
    options: { startQuery, authStatus } satisfies ClaudeOptions,
  };
}
