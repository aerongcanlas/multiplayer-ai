import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { ClaudeAdapter } from "./adapter";
import { claudeFixture } from "./fixture";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessSession,
  type SessionEvent,
} from "../contract";
import { launchEnvironment } from "../environment";
import { HarnessRegistry } from "../registry";
import { ProgramManager } from "../../programs/manager";
import { HARNESS_MANIFEST } from "../../programs/manifest";
import type { Loadout } from "../../../shared/tabs";

const loadout: Loadout = {
  harness: "claude",
  model: "default",
  effort: "medium",
  planMode: false,
  access: "ask",
};

async function setup(options: { idleMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-claude-"));
  const fixture = claudeFixture(join(dir, "state.json"));
  const make = () => new ClaudeAdapter({ ...fixture.options, ...options });
  const context = {
    executable: "/managed/claude",
    env: launchEnvironment({
      PATH: process.env.PATH,
      HOME: "/home/host",
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
    }),
  };
  const open = (
    adapter: ClaudeAdapter,
    extra: Partial<Loadout> = {},
    sessionId?: string,
    listener?: (event: SessionEvent) => void,
  ) =>
    adapter.open({
      ...context,
      tabId: randomUUID(),
      cwd: dir,
      loadout: { ...loadout, ...extra },
      ...(sessionId ? { sessionId } : {}),
      ...(listener ? { listener } : {}),
    });
  return { dir, fixture, make, context, open };
}

async function run(
  session: HarnessSession,
  prompt: string,
  turn: Loadout = loadout,
  handle: (event: HarnessEvent) => void | Promise<void> = () => {},
) {
  const events: HarnessEvent[] = [];
  for await (const event of session.send(prompt, turn)) {
    events.push(event);
    await handle(event);
  }
  return events;
}
const assistant = (events: HarnessEvent[]) =>
  events
    .filter((event) => event.type === "message" && event.kind === "assistant")
    .map((event) => (event.type === "message" ? event.text : ""))
    .join("|");

test("a send streams assistant text with the host's setup and a scrubbed environment", async () => {
  const { fixture, make, open, context } = await setup();
  const adapter = make();
  try {
    const session = await open(adapter);
    const events = await run(session, "Hello");
    assert.equal(events[0].type, "session");
    assert.ok(
      events.some(
        (event) => event.type === "text" && event.kind === "assistant",
      ),
    );
    assert.match(
      assistant(events),
      /Claude fixture reply \(previous turns: 0\)/,
    );
    const [options] = fixture.record.options;
    assert.deepEqual(options.systemPrompt, {
      type: "preset",
      preset: "claude_code",
    });
    assert.deepEqual(options.settingSources, ["user", "project", "local"]);
    assert.equal(options.pathToClaudeCodeExecutable, context.executable);
    assert.equal(options.permissionMode, "default");
    assert.equal(options.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
    assert.equal(options.env?.DISABLE_AUTOUPDATER, "1");
    assert.ok(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP);
    assert.equal(options.env?.PATH, process.env.PATH);
    assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.resume, undefined);
    // The loadout is applied before every later turn.
    await run(session, "Again", { ...loadout, model: "haiku", effort: "low" });
    assert.ok(fixture.record.calls.includes("model:haiku"));
    assert.ok(fixture.record.calls.includes('flags:{"effortLevel":"low"}'));
    assert.ok(fixture.record.calls.includes("mode:default"));
  } finally {
    adapter.close();
  }
});

test("on Windows without Git Bash the launch neither requires nor sets a Git Bash path", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  const { fixture, make, open } = await setup();
  const adapter = make();
  try {
    const session = await open(adapter);
    await run(session, "Hello");
    assert.equal(
      fixture.record.options[0].env?.CLAUDE_CODE_GIT_BASH_PATH,
      undefined,
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
    adapter.close();
  }
});

test("an AskUserQuestion call becomes a question and the answer reaches the skill", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  try {
    const session = await open(adapter);
    const events = await run(
      session,
      "/review FIXTURE_ASK",
      loadout,
      (event) => {
        if (event.type === "question")
          session.answer(event.request, { "0": ["Thorough"] });
      },
    );
    const question = events.find((event) => event.type === "question");
    assert.equal(
      question?.type === "question" && question.questions[0].question,
      "Which approach should the skill take?",
    );
    assert.deepEqual(
      question?.type === "question" &&
        question.questions[0].options.map((option) => option.label),
      ["Fast", "Thorough"],
    );
    assert.match(
      assistant(events),
      /"Which approach should the skill take\?":"Thorough"/,
    );
    assert.ok(
      fixture.record.calls.some((call) =>
        call.startsWith('ask:{"behavior":"allow"'),
      ),
    );
  } finally {
    adapter.close();
  }
});

test("plan mode is native, and continuing from ExitPlanMode switches to the tab's access mode", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  try {
    const plan = { ...loadout, planMode: true };
    const session = await open(adapter, { planMode: true });
    const events = await run(
      session,
      "Plan FIXTURE_EXIT_PLAN",
      plan,
      (event) => {
        if (event.type === "approval") {
          assert.equal(event.plan, true);
          assert.match(event.summary, /Read the code/);
          session.respond(event.request, "accept");
        }
      },
    );
    assert.equal(fixture.record.options[0].permissionMode, "plan");
    assert.ok(fixture.record.calls.includes("mode:default"));
    assert.ok(fixture.record.calls.includes("exit-plan:allow:default"));
    assert.match(assistant(events), /Implementing the plan/);
  } finally {
    adapter.close();
  }
});

test("ask mode waits on Bash approval and auto mode allows it without asking", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  try {
    const session = await open(adapter);
    const asked = await run(session, "FIXTURE_BASH", loadout, (event) => {
      if (event.type === "approval") {
        assert.equal(event.summary, "Run command: ls -la");
        session.respond(event.request, "decline");
      }
    });
    assert.ok(asked.some((event) => event.type === "approval"));
    assert.ok(fixture.record.calls.includes("bash:deny"));
    const auto = await run(session, "FIXTURE_BASH", {
      ...loadout,
      access: "auto",
    });
    assert.equal(
      auto.some((event) => event.type === "approval"),
      false,
    );
    assert.ok(fixture.record.calls.includes("bash:allow"));
    assert.ok(fixture.record.calls.includes("mode:acceptEdits"));
    const tool = auto.filter((event) => event.type === "tool").at(-1);
    assert.equal(tool?.type === "tool" && tool.detail, "README.md");
  } finally {
    adapter.close();
  }
});

test("reopening passes the stored session to resume, and an unknown session is a resume failure", async () => {
  const { fixture, make, open } = await setup();
  const first = make();
  const session = await open(first);
  await run(session, "Hello");
  const sessionId = session.sessionId!;
  first.close();
  const second = make();
  try {
    const resumed = await open(second, {}, sessionId);
    const events = await run(resumed, "Follow up");
    assert.equal(fixture.record.options.at(-1)?.resume, sessionId);
    assert.match(assistant(events), /previous turns: 1/);
    const missing = await open(second, {}, randomUUID());
    await assert.rejects(run(missing, "Hello"), (error: HarnessError) => {
      assert.equal(error.kind, "resume_failed");
      return true;
    });
  } finally {
    second.close();
  }
});

test("inspect reuses the machine's login, and a signed-out machine gets guidance only", async () => {
  const { fixture, make, context } = await setup();
  const adapter = make();
  try {
    const signedIn = await adapter.inspect(context);
    assert.equal(signedIn.auth.state, "signed_in");
    assert.equal(signedIn.auth.account, "fixture@example.invalid");
    assert.deepEqual(signedIn.models[0].efforts, ["low", "medium", "high"]);
    assert.deepEqual(signedIn.models[1].efforts, []);
    assert.equal(adapter.signIn, "guidance");
    assert.equal("startSignIn" in adapter, false);
    fixture.setSignedIn(false);
    const signedOut = await adapter.inspect(context);
    assert.equal(signedOut.auth.state, "signed_out");
    assert.match(signedOut.auth.message ?? "", /\/login/);
    assert.deepEqual(signedOut.models, []);
  } finally {
    adapter.close();
  }
});

test("a missing custom binary is reported as program state without a download", async () => {
  const { dir, fixture } = await setup();
  const settings = new Map<string, unknown>([
    ["harness.claude.executable", join(dir, "missing-claude")],
  ]);
  let requests = 0;
  const registry = new HarnessRegistry({
    adapters: [new ClaudeAdapter(fixture.options)],
    programs: new ProgramManager({
      root: dir,
      manifest: HARNESS_MANIFEST,
      fetch: (async () => {
        requests++;
        throw new Error("no network");
      }) as typeof fetch,
    }),
    settings: {
      getSetting: <T>(key: string) => settings.get(key) as T,
      setSetting: (key, value) => settings.set(key, value),
    },
    changed: () => {},
    environmentTimeoutMs: 0,
  });
  try {
    await registry.refresh("claude");
    const state = registry.state("claude");
    assert.equal(state.program.state, "custom_invalid");
    assert.equal(state.auth.state, "unknown");
    assert.equal(requests, 0);
  } finally {
    registry.close();
  }
});

test("Stop denies a pending approval and interrupts, and a usage limit carries its reset time", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  try {
    const session = await open(adapter);
    await run(session, "FIXTURE_BASH", loadout, async (event) => {
      if (event.type === "approval") await session.stop();
    });
    assert.ok(fixture.record.calls.includes("bash:deny"));
    assert.ok(fixture.record.calls.includes("interrupt"));
    await assert.rejects(
      run(session, "FIXTURE_USAGE"),
      (error: HarnessError) => {
        assert.equal(error.kind, "usage_limit");
        assert.equal(error.resetsAt, 2_000_000_000);
        return true;
      },
    );
  } finally {
    adapter.close();
  }
});

test("an idle query closes, does not re-arm after close, and the next send resumes", async () => {
  const { fixture, make, open } = await setup({ idleMs: 30 });
  const adapter = make();
  const session = await open(adapter);
  await run(session, "Hello");
  await wait(100);
  assert.equal(
    fixture.record.calls.filter((call) => call === "close").length,
    1,
  );
  const events = await run(session, "Follow up");
  assert.match(assistant(events), /previous turns: 1/);
  assert.equal(fixture.record.options.at(-1)?.resume, session.sessionId);
  session.close();
  adapter.close();
  await wait(100);
  assert.equal(
    fixture.record.calls.filter((call) => call === "close").length,
    2,
  );
});

const agentEvents = (events: SessionEvent[], key?: string) =>
  events.filter(
    (event): event is Extract<SessionEvent, { type: "agent" }> =>
      event.type === "agent" && (!key || event.key === key),
  );
const until = async (check: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await wait(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

test("sub-agents report cards, their own entries, nesting, and requests on the listener", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  const heard: SessionEvent[] = [];
  let session: HarnessSession;
  try {
    session = await open(adapter, {}, undefined, (event) => {
      heard.push(event);
      if (event.type === "approval") session.respond(event.request, "accept");
    });
    const events = await run(session, "FIXTURE_AGENTS");
    const [started, progress, done] = agentEvents(heard, "t1");
    assert.deepEqual(started, {
      type: "agent",
      key: "t1",
      description: "Inspect the checkout",
      agentType: "Explore",
      background: false,
      status: "running",
    });
    assert.equal(progress.toolUses, 2);
    assert.equal(progress.latestTool, "Agent");
    assert.equal(done.status, "completed");
    assert.equal(done.summary, "Found README.md.");
    const nested = agentEvents(heard, "t2");
    assert.equal(nested[0].parentKey, "t1");
    assert.equal(nested.at(-1)?.summary, "A short README.");
    // Sub-agent messages and tools carry their card, never reaching the lead's turn.
    assert.ok(
      heard.some(
        (event) =>
          event.type === "message" &&
          event.agent === "t1" &&
          event.text === "Looking around.",
      ),
    );
    assert.ok(
      heard.some(
        (event) =>
          event.type === "message" &&
          event.agent === "t2" &&
          event.text === "A short README.",
      ),
    );
    const subTools = heard.filter(
      (event) => event.type === "tool" && event.agent === "t1",
    );
    assert.deepEqual(
      subTools.map((event) => event.type === "tool" && event.item),
      ["sub-bash", "sub-bash", "agent-2"],
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool" &&
          (event.item === "sub-bash" || event.item === "agent-2"),
      ),
      false,
    );
    assert.ok(
      events.some((event) => event.type === "tool" && event.item === "agent-1"),
    );
    const approval = heard.find((event) => event.type === "approval");
    assert.equal(approval?.type === "approval" && approval.agent, "t1");
    assert.ok(fixture.record.calls.includes("sub-bash:allow"));
    // The lead's TodoWrite becomes its plan.
    const steps = events.find((event) => event.type === "steps");
    assert.deepEqual(steps?.type === "steps" && steps.steps, [
      { text: "Inspect", status: "done" },
      { text: "Test", status: "active" },
      { text: "Ship", status: "pending" },
    ]);
    assert.match(assistant(events), /Inspection done/);
  } finally {
    adapter.close();
  }
});

test("the lead's TaskCreate and TaskUpdate calls become its plan, and a sub-agent's list does not", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  try {
    const session = await open(adapter, {}, undefined, () => {});
    const lead = (content: Record<string, unknown>[], parent?: string) =>
      fixture.inject({
        type: "assistant",
        message: { id: `msg_${randomUUID()}`, content },
        parent_tool_use_id: parent ?? null,
      });
    const created = (id: string, task: string) =>
      fixture.inject({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
        },
        tool_use_result: { task: { id: task, subject: "" } },
        parent_tool_use_id: null,
      });
    const tool = (
      id: string,
      name: string,
      input: Record<string, unknown>,
    ) => ({
      type: "tool_use",
      id,
      name,
      input,
    });
    const plans: unknown[] = [];
    // The interrupt that ends this turn fails it, as any stopped turn does.
    const turn = run(session, "FIXTURE_SLOW", loadout, async (event) => {
      if (event.type === "steps") plans.push(event.steps);
      if (event.type !== "session") return;
      lead([tool("c1", "TaskCreate", { subject: "Write tests" })]);
      created("c1", "1");
      lead([tool("c2", "TaskCreate", { subject: "Ship" })]);
      created("c2", "2");
      lead([tool("u1", "TaskUpdate", { taskId: "1", status: "completed" })]);
      lead([tool("u2", "TaskUpdate", { taskId: "2", status: "deleted" })]);
      // A sub-agent's to-do list stays off the lead's plan.
      fixture.inject({
        type: "system",
        subtype: "task_started",
        task_id: "t9",
        tool_use_id: "c2",
        task_type: "local_agent",
        description: "Helper",
      });
      lead(
        [
          tool("todo-sub", "TodoWrite", {
            todos: [{ content: "Sub", status: "pending", activeForm: "" }],
          }),
        ],
        "c2",
      );
      await wait(10);
      await session.stop();
    });
    await assert.rejects(turn, /Interrupted/);
    assert.deepEqual(plans, [
      [{ text: "Write tests", status: "pending" }],
      [
        { text: "Write tests", status: "pending" },
        { text: "Ship", status: "pending" },
      ],
      [
        { text: "Write tests", status: "done" },
        { text: "Ship", status: "pending" },
      ],
      [{ text: "Write tests", status: "done" }],
    ]);
  } finally {
    adapter.close();
  }
});

test("a sub-agent request waits for the owner outside a turn and after the turn ends", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  const heard: SessionEvent[] = [];
  try {
    const session = await open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    let during: Promise<unknown> | undefined;
    await run(session, "Hello", loadout, (event) => {
      if (event.type === "session")
        during = fixture.record.options[0].canUseTool!(
          "Bash",
          { command: "pnpm test" },
          {
            signal: new AbortController().signal,
            toolUseID: "t-1",
            requestId: "r-1",
            agentID: "agent-a",
          },
        );
    });
    let settled = false;
    void during!.then(() => (settled = true));
    await wait(10);
    assert.equal(settled, false);
    const first = heard.find((event) => event.type === "approval")!;
    assert.equal(first?.type === "approval" && first.agent, "agent-a");
    session.respond(first!.type === "approval" ? first.request : "", "accept");
    assert.equal(((await during) as { behavior: string }).behavior, "allow");
    // With no turn at all, the request still reaches the owner instead of being denied.
    const idle = fixture.record.options[0].canUseTool!(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "t-2",
        requestId: "r-2",
        agentID: "agent-a",
      },
    );
    const second = heard.filter((event) => event.type === "approval").at(-1)!;
    assert.equal(
      second?.type === "approval" && second.summary,
      "Run command: ls",
    );
    session.respond(
      second!.type === "approval" ? second.request : "",
      "decline",
    );
    assert.equal(((await idle) as { behavior: string }).behavior, "deny");
  } finally {
    adapter.close();
  }
});

test("background work keeps the query, a finished sub-agent wakes the lead in its own turn, and the idle timer arms after", async () => {
  const { fixture, make, open } = await setup({ idleMs: 30 });
  const adapter = make();
  const heard: SessionEvent[] = [];
  try {
    const session = await open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    const events = await run(session, "FIXTURE_BACKGROUND");
    assert.match(assistant(events), /background/);
    // Only the sub-agent gets a card; the shell command does not.
    assert.deepEqual(
      agentEvents(heard).map((event) => [event.key, event.background]),
      [["t3", true]],
    );
    await wait(80);
    assert.equal(fixture.record.calls.includes("close"), false);
    fixture.finishBackground();
    await until(
      () => heard.some((event) => event.type === "turn.completed"),
      "harness turn",
    );
    const after = heard.slice(
      heard.findIndex(
        (event) => event.type === "agent" && event.status === "completed",
      ),
    );
    assert.deepEqual(
      after.map((event) => event.type),
      ["agent", "turn.started", "message", "turn.completed"],
    );
    assert.equal(agentEvents(heard, "t3").at(-1)?.summary, "All tests passed.");
    // Its result ended the harness turn, so the owner's next turn runs normally.
    const next = await run(session, "Hello");
    assert.match(assistant(next), /Claude fixture reply/);
    await wait(80);
    assert.equal(fixture.record.calls.includes("close"), false);
    fixture.finishShell();
    await until(() => fixture.record.calls.includes("close"), "idle release");
  } finally {
    adapter.close();
  }
});

test("Stop interrupts and stops each background task, and cards settle from task notifications", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  const heard: SessionEvent[] = [];
  try {
    const session = await open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    await run(session, "FIXTURE_BACKGROUND");
    await session.stop();
    assert.ok(fixture.record.calls.includes("interrupt"));
    assert.ok(fixture.record.calls.includes("stopTask:t3"));
    assert.ok(fixture.record.calls.includes("stopTask:t4"));
    await until(
      () => agentEvents(heard, "t3").at(-1)?.status === "stopped",
      "stopped card",
    );
    const task = (subtype: string, fields: Record<string, unknown>) =>
      fixture.inject({ type: "system", subtype, ...fields });
    task("task_started", {
      task_id: "t8",
      task_type: "local_agent",
      description: "Try",
    });
    task("task_notification", {
      task_id: "t8",
      status: "failed",
      summary: "It broke.",
      output_file: "",
    });
    task("task_started", {
      task_id: "t9",
      task_type: "local_agent",
      description: "Try",
    });
    task("task_updated", { task_id: "t9", patch: { status: "killed" } });
    await until(
      () => agentEvents(heard, "t9").at(-1)?.status === "stopped",
      "killed card",
    );
    assert.equal(agentEvents(heard, "t8").at(-1)?.status, "failed");
    assert.equal(agentEvents(heard, "t8").at(-1)?.summary, "It broke.");
  } finally {
    adapter.close();
  }
});

test("the query ending with background work and no turn reports a crash", async () => {
  const { fixture, make, open } = await setup();
  const adapter = make();
  const heard: SessionEvent[] = [];
  try {
    const session = await open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    await run(session, "FIXTURE_BACKGROUND");
    fixture.exit();
    await until(
      () => heard.some((event) => event.type === "crashed"),
      "crash report",
    );
    // The next send starts a fresh query that resumes the session.
    const next = await run(session, "Hello");
    assert.match(assistant(next), /previous turns: 1/);
  } finally {
    adapter.close();
  }
});
