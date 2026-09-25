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
import { EventQueue } from "../queue";

// A scripted Claude Agent SDK query for tests and MP_E2E only. It never starts Claude Code or
// makes network requests. Prompt markers select behavior: FIXTURE_ASK (an AskUserQuestion call),
// FIXTURE_BASH (a Bash tool call), FIXTURE_EXIT_PLAN (an ExitPlanMode call in plan mode),
// FIXTURE_USAGE (a usage limit), FIXTURE_SLOW (waits for an interrupt), FIXTURE_CRASH,
// FIXTURE_AGENTS (a sub-agent with a nested one, an approval from inside it, and a to-do list), and
// FIXTURE_BACKGROUND (a background sub-agent and a background shell command that outlive the
// turn; after the turn the sub-agent asks to run a command, then completes and Claude Code replies
// on its own, and `finishShell` ends the shell command). Sessions persist in the state file so a
// restarted app can resume them.

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
const frame = (
  type: "assistant" | "user",
  parent: string | null,
  content: Record<string, unknown>[],
  sessionId: string,
) =>
  message({
    type,
    message:
      type === "assistant"
        ? { id: `msg_${randomUUID()}`, content }
        : { role: "user", content },
    parent_tool_use_id: parent,
    session_id: sessionId,
  });
const task = (
  subtype: string,
  sessionId: string,
  fields: Record<string, unknown>,
) => message({ type: "system", subtype, session_id: sessionId, ...fields });

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
  // The latest query's output and background tasks, for scripted events after a turn.
  let current:
    | {
        outbox: EventQueue<SDKMessage>;
        sessionId: string;
        background: Map<string, string>;
      }
    | undefined;
  const changed = () =>
    current!.outbox.push(
      task("background_tasks_changed", current!.sessionId, {
        tasks: [...current!.background].map(([task_id, task_type]) => ({
          task_id,
          task_type,
          description: task_id,
        })),
      }),
    );

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
    const outbox = new EventQueue<SDKMessage>();
    const backgroundTasks = new Map<string, string>();
    current = { outbox, sessionId, background: backgroundTasks };
    const tool = (
      name: string,
      input: Record<string, unknown>,
      extra: { agentID?: string; toolUseID?: string } = {},
    ) =>
      options.canUseTool!(name, input, {
        signal: new AbortController().signal,
        toolUseID: randomUUID(),
        requestId: randomUUID(),
        ...extra,
      }) as Promise<PermissionResult>;

    // FIXTURE_BACKGROUND's sub-agent after the turn: one approval, then its result and a reply
    // Claude Code starts by itself. A Stop denies the approval and stops the task instead.
    async function backgroundAgent() {
      outbox.push(
        frame(
          "assistant",
          "agent-3",
          [
            { type: "text", text: "Running the test suite." },
            {
              type: "tool_use",
              id: "bg-bash",
              name: "Bash",
              input: { command: "pnpm test" },
            },
          ],
          sessionId,
        ),
      );
      const result = await tool(
        "Bash",
        { command: "pnpm test" },
        { agentID: "t3", toolUseID: "bg-bash" },
      );
      record.calls.push(`bg-bash:${result.behavior}`);
      if (closed || !backgroundTasks.has("t3")) return;
      if (result.behavior === "deny" && result.interrupt) return;
      const summary =
        result.behavior === "allow"
          ? "All tests passed."
          : "Skipped the test run.";
      backgroundTasks.delete("t3");
      outbox.push(
        task("task_notification", sessionId, {
          task_id: "t3",
          tool_use_id: "agent-3",
          status: "completed",
          summary,
          output_file: "",
        }),
      );
      changed();
      outbox.push(
        frame(
          "assistant",
          null,
          [{ type: "text", text: `The background agent reports: ${summary}` }],
          sessionId,
        ),
      );
      outbox.push(
        message({
          type: "result",
          subtype: "success",
          is_error: false,
          result: summary,
          session_id: sessionId,
        }),
      );
    }

    async function* run(): AsyncGenerator<SDKMessage> {
      if (resumed && !(resumed in load().sessions))
        throw new Error(`No conversation found with session ID: ${resumed}`);
      for await (const input of params.prompt) {
        if (closed) return;
        const prompt = String(input.message.content);
        const uuid = input.uuid;
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
        if (prompt.includes("FIXTURE_AGENTS")) {
          yield frame(
            "assistant",
            null,
            [
              {
                type: "tool_use",
                id: "todo-1",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "Inspect", status: "completed", activeForm: "" },
                    { content: "Test", status: "in_progress", activeForm: "" },
                    { content: "Ship", status: "pending", activeForm: "" },
                  ],
                },
              },
              {
                type: "tool_use",
                id: "agent-1",
                name: "Agent",
                input: { description: "Inspect the checkout" },
              },
            ],
            sessionId,
          );
          yield task("task_started", sessionId, {
            task_id: "t1",
            tool_use_id: "agent-1",
            task_type: "local_agent",
            description: "Inspect the checkout",
            subagent_type: "Explore",
            is_backgrounded: false,
          });
          yield frame(
            "assistant",
            "agent-1",
            [
              { type: "text", text: "Looking around." },
              {
                type: "tool_use",
                id: "sub-bash",
                name: "Bash",
                input: { command: "ls" },
              },
            ],
            sessionId,
          );
          const result = await tool(
            "Bash",
            { command: "ls" },
            { agentID: "t1", toolUseID: "sub-bash" },
          );
          record.calls.push(`sub-bash:${result.behavior}`);
          yield frame(
            "user",
            "agent-1",
            [
              {
                type: "tool_result",
                tool_use_id: "sub-bash",
                content: "README.md",
              },
            ],
            sessionId,
          );
          yield frame(
            "assistant",
            "agent-1",
            [
              {
                type: "tool_use",
                id: "agent-2",
                name: "Agent",
                input: { description: "Read the README" },
              },
            ],
            sessionId,
          );
          yield task("task_started", sessionId, {
            task_id: "t2",
            tool_use_id: "agent-2",
            task_type: "local_agent",
            description: "Read the README",
            subagent_type: "general-purpose",
          });
          yield frame(
            "assistant",
            "agent-2",
            [{ type: "text", text: "A short README." }],
            sessionId,
          );
          yield task("task_notification", sessionId, {
            task_id: "t2",
            tool_use_id: "agent-2",
            status: "completed",
            summary: "A short README.",
            output_file: "",
          });
          yield task("task_progress", sessionId, {
            task_id: "t1",
            tool_use_id: "agent-1",
            description: "Inspect the checkout",
            usage: { total_tokens: 10, tool_uses: 2, duration_ms: 5 },
            last_tool_name: "Agent",
          });
          yield task("task_notification", sessionId, {
            task_id: "t1",
            tool_use_id: "agent-1",
            status: "completed",
            summary: "Found README.md.",
            output_file: "",
            usage: { total_tokens: 20, tool_uses: 2, duration_ms: 9 },
          });
          yield frame(
            "user",
            null,
            [
              {
                type: "tool_result",
                tool_use_id: "agent-1",
                content: "Found README.md.",
              },
            ],
            sessionId,
          );
          reply.push("Inspection done.");
        }
        if (prompt.includes("FIXTURE_BACKGROUND")) {
          yield frame(
            "assistant",
            null,
            [
              {
                type: "tool_use",
                id: "agent-3",
                name: "Agent",
                input: {
                  description: "Run the tests",
                  run_in_background: true,
                },
              },
            ],
            sessionId,
          );
          yield task("task_started", sessionId, {
            task_id: "t3",
            tool_use_id: "agent-3",
            task_type: "local_agent",
            description: "Run the tests",
            subagent_type: "general-purpose",
            is_backgrounded: true,
          });
          yield task("task_started", sessionId, {
            task_id: "t4",
            task_type: "local_bash",
            description: "pnpm dev",
            is_backgrounded: true,
          });
          backgroundTasks.set("t3", "local_agent").set("t4", "local_bash");
          changed();
          reply.push("The tests run in the background.");
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
            user_message_uuid: uuid,
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
                user_message_uuid: uuid,
                session_id: sessionId,
              }
            : interrupted
              ? {
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  errors: ["Interrupted"],
                  user_message_uuid: uuid,
                  session_id: sessionId,
                }
              : {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  result: text,
                  user_message_uuid: uuid,
                  session_id: sessionId,
                },
        );
        interrupted = undefined;
        if (prompt.includes("FIXTURE_BACKGROUND"))
          setTimeout(() => void backgroundAgent(), 150);
      }
    }

    void (async () => {
      try {
        for await (const item of run()) outbox.push(item);
        outbox.end();
      } catch (error) {
        outbox.fail(error);
      }
    })();
    return {
      [Symbol.asyncIterator]: () => outbox[Symbol.asyncIterator](),
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
      stopTask: async (taskId) => {
        record.calls.push(`stopTask:${taskId}`);
        if (!backgroundTasks.delete(taskId)) return;
        outbox.push(
          task("task_notification", sessionId, {
            task_id: taskId,
            status: "stopped",
            summary: "",
            output_file: "",
          }),
        );
        changed();
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
    /** Ends FIXTURE_BACKGROUND's shell command. */
    finishShell: () => {
      current!.background.delete("t4");
      changed();
    },
    /** Delivers an SDK message on the latest query, as Claude Code would unprompted. */
    inject: (value: Record<string, unknown>) =>
      current!.outbox.push(
        message({ session_id: current!.sessionId, ...value }),
      ),
    /** Ends the query's output as if Claude Code exited. */
    exit: () => current!.outbox.end(),
    setSignedIn: (signedIn: boolean) => save({ ...load(), signedIn }),
    options: { startQuery, authStatus } satisfies ClaudeOptions,
  };
}
