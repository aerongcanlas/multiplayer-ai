import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { CodexAdapter } from "./adapter";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessSession,
  type SessionEvent,
} from "../contract";
import { launchEnvironment } from "../environment";
import type { Loadout } from "../../../shared/tabs";

const fixture = resolve(
  import.meta.dirname,
  "../../../../scripts/codex-fixture.mjs",
);
const loadout: Loadout = {
  harness: "codex",
  model: "fixture-codex",
  effort: "low",
  planMode: false,
  access: "ask",
};

test("context generation preserves drafts and errors even when its temporary directory stays locked", () =>
  withAdapter(async (adapter, fixture) => {
    const inspection = await adapter.inspect(fixture.context);
    const model = inspection.models[0];
    const messages = [
      {
        id: randomUUID(),
        authorId: randomUUID(),
        authorName: "Alice",
        text: "Add a theme toggle. FIXTURE_MULTIPLE_PROMPTS FIXTURE_SUGGESTION_LOCK",
        createdAt: new Date().toISOString(),
      },
    ];
    const request = { ...fixture.context, model, messages };
    const generated = await adapter.suggest(request);
    assert.deepEqual(generated.suggestedPrompts, [
      "Add a dark mode toggle, persist the selected theme, and verify it survives a restart.",
      "Verify keyboard navigation and focus visibility for the theme toggle.",
    ]);
    const start = (await fixture.requests("thread/start"))[0].params!;
    assert.equal(start.ephemeral, true);
    assert.equal(start.sandbox, "read-only");
    assert.equal(start.approvalPolicy, "never");
    assert.equal(
      (start.config as Record<string, unknown>)["features.shell_tool"],
      false,
    );
    const turn = (await fixture.requests("turn/start"))[0].params!;
    assert.deepEqual(JSON.parse((turn.input as { text: string }[])[0].text), {
      messages,
      context: null,
    });
    assert.equal((await fixture.requests("thread/unsubscribe")).length, 1);
    for (const [text, error] of [
      ["FIXTURE_SUGGESTION_FAILURE", /Fixture suggestion failure/],
      ["FIXTURE_SUGGESTION_INVALID", /invalid suggestions/],
    ] as const)
      await assert.rejects(
        adapter.suggest({
          ...request,
          messages: [
            { ...messages[0], text: `${text} FIXTURE_SUGGESTION_LOCK` },
          ],
        }),
        error,
      );
    assert.equal((await fixture.requests("thread/unsubscribe")).length, 3);
  }));

async function setup(
  options: { signedIn?: boolean; loginUrl?: string; idleMs?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-codex-"));
  const logFile = join(dir, "log.jsonl");
  const stateFile = join(dir, "threads.json");
  const make = () =>
    new CodexAdapter({
      idleMs: options.idleMs,
      launcher: (_executable, args, env) => ({
        executable: process.execPath,
        args: [fixture, ...args],
        env: {
          ...env,
          MP_FIXTURE_LOG: logFile,
          MP_FIXTURE_STATE: stateFile,
          ...(options.signedIn === false ? {} : { MP_FIXTURE_SIGNED_IN: "1" }),
          ...(options.loginUrl
            ? { MP_FIXTURE_LOGIN_URL: options.loginUrl }
            : {}),
        },
      }),
    });
  const home = join(dir, "accounts", "codex");
  const context = {
    executable: "/managed/codex",
    // The registry strips provider credentials before any adapter sees the environment.
    env: {
      ...launchEnvironment({
        PATH: process.env.PATH,
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        OPENAI_API_KEY: "sk-should-not-leak",
        CODEX_API_KEY: "should-not-leak",
      }),
      CODEX_HOME: home,
    },
    home,
    hostPaths: {},
  };
  const log = async () =>
    (await readFile(logFile, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as Record<string, unknown> & {
            params?: Record<string, unknown>;
          },
      );
  const requests = async (method: string) =>
    (await log()).filter(
      (entry) => entry.type === "request" && entry.method === method,
    );
  const answers = async (method: string) =>
    (await log()).filter(
      (entry) => entry.type === "answer" && entry.method === method,
    );
  const open = (
    adapter: CodexAdapter,
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
  return { dir, make, context, log, requests, answers, open };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
type Body = (adapter: CodexAdapter, fixture: Fixture) => Promise<void>;
type Options = Parameters<typeof setup>[0];
async function withAdapter(body: Body): Promise<void>;
async function withAdapter(options: Options, body: Body): Promise<void>;
async function withAdapter(options: Options | Body, body?: Body) {
  if (typeof options === "function") return withAdapter({}, options);
  const fixture = await setup(options);
  const adapter = fixture.make();
  try {
    await body!(adapter, fixture);
  } finally {
    adapter.close();
  }
}

/** Runs a turn, letting a handler answer requests as they arrive. */
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

const text = (events: HarnessEvent[], kind: string) =>
  events
    .filter(
      (event) =>
        (event.type === "message" || event.type === "text") &&
        event.kind === kind,
    )
    .map((event) =>
      event.type === "message"
        ? event.text
        : event.type === "text"
          ? event.delta
          : "",
    )
    .join("|");

test("inspect lists fixture models with their efforts and the account", () =>
  withAdapter(async (adapter, setup_) => {
    const inspection = await adapter.inspect(setup_.context);
    assert.equal(inspection.auth.state, "signed_in");
    assert.equal(inspection.auth.account, "fixture@example.invalid");
    assert.deepEqual(inspection.models, [
      {
        id: "fixture-codex",
        name: "Fixture Codex",
        efforts: ["medium", "low"],
        defaultEffort: "medium",
        isDefault: true,
      },
    ]);
    assert.equal(inspection.limits[0].usedPercent, 20);
    const { version } = await adapter.handshake(setup_.context);
    assert.equal(version, "0.160.0");
  }));

test("a send streams an assistant message on a thread in the tab's checkout with the loadout", () =>
  withAdapter(async (adapter, setup_) => {
    const session = await setup_.open(adapter);
    const events = await run(session, "Hello");
    assert.equal(events[0].type, "session");
    assert.match(
      text(
        events.filter((event) => event.type === "message"),
        "assistant",
      ),
      /Fixture reply \(previous turns: 0\) with fixture-codex/,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool" &&
          event.summary.startsWith("git status --short"),
      ),
    );
    const [start] = await setup_.requests("thread/start");
    assert.equal(start.params?.cwd, setup_.dir);
    assert.equal(start.params?.model, "fixture-codex");
    const [turn] = await setup_.requests("turn/start");
    assert.deepEqual(turn.params?.collaborationMode, {
      mode: "default",
      settings: {
        model: "fixture-codex",
        reasoning_effort: "low",
        developer_instructions: null,
      },
    });
    assert.equal(turn.params?.approvalPolicy, "on-request");
    assert.deepEqual(turn.params?.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    const [initialize] = await setup_.requests("initialize");
    assert.deepEqual(initialize.params?.capabilities, {
      experimentalApi: true,
      requestAttestation: false,
    });
    // The host's setup loads: no restrictive overrides, and no provider credentials.
    const launch = (await setup_.log()).find(
      (entry) => entry.type === "launch",
    )!;
    assert.deepEqual(launch.argv, ["app-server", "--listen", "stdio://"]);
    const env = launch.env as Record<string, string>;
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
  }));

test("a reopened tab resumes its thread, and a missing thread is a resume failure", async () => {
  const setup_ = await setup();
  const first = setup_.make();
  const session = await setup_.open(first);
  await run(session, "Hello");
  const threadId = session.sessionId!;
  first.close();
  const second = setup_.make();
  try {
    const resumed = await setup_.open(second, {}, threadId);
    const events = await run(resumed, "Follow up");
    assert.equal(
      events.some((event) => event.type === "session"),
      false,
    );
    assert.match(text(events, "assistant"), /previous turns: 1/);
    assert.equal(
      (await setup_.requests("thread/resume")).at(-1)?.params?.threadId,
      threadId,
    );
    await assert.rejects(
      setup_.open(second, {}, randomUUID()),
      (error: HarnessError) => {
        assert.equal(error.kind, "resume_failed");
        return true;
      },
    );
    assert.equal((await setup_.requests("thread/start")).length, 1);
  } finally {
    second.close();
  }
});

test("plan mode uses Codex's native plan mode and continuing uses the default mode", () =>
  withAdapter(async (adapter, setup_) => {
    const session = await setup_.open(adapter);
    const planned = await run(session, "Plan it", {
      ...loadout,
      planMode: true,
    });
    assert.match(text(planned, "plan"), /Inspect the repository/);
    await run(session, "Implement the plan.", loadout);
    const turns = await setup_.requests("turn/start");
    assert.deepEqual(
      turns.map(
        (turn) => (turn.params?.collaborationMode as { mode: string }).mode,
      ),
      ["plan", "default"],
    );
  }));

test("ask mode surfaces approvals and auto mode lets Codex act without asking", () =>
  withAdapter(async (adapter, setup_) => {
    const session = await setup_.open(adapter);
    const events = await run(session, "FIXTURE_APPROVAL", loadout, (event) => {
      if (event.type === "approval") session.respond(event.request, "accept");
    });
    const approval = events.find((event) => event.type === "approval");
    assert.equal(
      approval?.type === "approval" && approval.summary,
      "Run command: git status --short",
    );
    assert.deepEqual(
      (await setup_.answers("item/commandExecution/requestApproval"))[0].result,
      { decision: "accept" },
    );

    await run(session, "FIXTURE_APPROVAL", loadout, (event) => {
      if (event.type === "approval") session.respond(event.request, "decline");
    });
    assert.deepEqual(
      (await setup_.answers("item/commandExecution/requestApproval"))[1].result,
      { decision: "decline" },
    );

    await run(session, "Go", { ...loadout, access: "auto" });
    const turn = (await setup_.requests("turn/start")).at(-1)!;
    assert.equal(turn.params?.approvalPolicy, "never");
    assert.deepEqual(turn.params?.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [setup_.dir],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  }));

test("user-input requests become questions and MCP forms map onto question cards", () =>
  withAdapter(async (adapter, setup_) => {
    const session = await setup_.open(adapter);
    const events = await run(session, "FIXTURE_QUESTION", loadout, (event) => {
      if (event.type === "question")
        session.answer(event.request, { scope: ["Small"] });
    });
    const question = events.find((event) => event.type === "question");
    assert.equal(
      question?.type === "question" && question.questions[0].allowOther,
      true,
    );
    assert.deepEqual(
      (await setup_.answers("item/tool/requestUserInput"))[0].result,
      {
        answers: { scope: { answers: ["Small"] } },
      },
    );
    assert.match(text(events, "assistant"), /Scope chosen: Small/);

    await run(session, "FIXTURE_ELICIT", loadout, (event) => {
      if (event.type === "question") {
        assert.deepEqual(
          event.questions[0].options.map((option) => option.label),
          ["us", "eu"],
        );
        session.answer(event.request, { region: ["eu"] });
      }
    });
    assert.deepEqual(
      (await setup_.answers("mcpServer/elicitation/request"))[0].result,
      {
        action: "accept",
        content: { region: "eu" },
        _meta: null,
      },
    );

    const unknown = await run(session, "FIXTURE_UNKNOWN_REQUEST");
    assert.ok(
      unknown.some(
        (event) =>
          event.type === "notice" && event.notice === "unsupported_request",
      ),
    );
    assert.equal(
      (
        (await setup_.answers("item/tool/call"))[0].result as {
          error: { code: number };
        }
      ).error.code,
      -32601,
    );
  }));

test("Stop cancels pending requests the way Codex expects, then interrupts the turn", () =>
  withAdapter(async (adapter, setup_) => {
    const session = await setup_.open(adapter);
    for (const prompt of [
      "FIXTURE_APPROVAL",
      "FIXTURE_QUESTION",
      "FIXTURE_PERMISSIONS",
    ])
      await run(session, prompt, loadout, async (event) => {
        if (event.type === "approval" || event.type === "question")
          await session.stop();
      });
    assert.deepEqual(
      (await setup_.answers("item/commandExecution/requestApproval"))[0].result,
      { decision: "cancel" },
    );
    assert.deepEqual(
      (await setup_.answers("item/tool/requestUserInput"))[0].result,
      { answers: {} },
    );
    assert.deepEqual(
      (await setup_.answers("item/permissions/requestApproval"))[0].result,
      {
        permissions: {},
        scope: "turn",
      },
    );
    assert.equal((await setup_.requests("turn/interrupt")).length, 3);

    // Stop with nothing pending just interrupts.
    const slow = run(session, "FIXTURE_SLOW");
    await wait(100);
    await session.stop();
    await slow;
    assert.equal((await setup_.requests("turn/interrupt")).length, 4);
  }));

test("a usage limit carries its reset time, and a crashed process restarts on the next send", () =>
  withAdapter(async (adapter, setup_) => {
    const session = await setup_.open(adapter);
    await assert.rejects(
      run(session, "FIXTURE_USAGE"),
      (error: HarnessError) => {
        assert.equal(error.kind, "usage_limit");
        assert.equal(error.resetsAt, 2_000_000_000);
        return true;
      },
    );
    await assert.rejects(
      run(session, "FIXTURE_CRASH"),
      (error: HarnessError) => {
        assert.equal(error.kind, "crashed");
        return true;
      },
    );
    const events = await run(session, "After the crash");
    assert.match(text(events, "assistant"), /Fixture reply/);
    assert.equal(
      (await setup_.log()).filter((entry) => entry.type === "launch").length,
      2,
    );
    assert.equal(
      (await setup_.requests("thread/resume")).at(-1)?.params?.threadId,
      session.sessionId,
    );
  }));

test("in-app sign-in returns only allowlisted URLs and reports completion", async () => {
  await withAdapter({ signedIn: false }, async (adapter, setup_) => {
    let changes = 0;
    adapter.onChange(() => changes++);
    assert.equal(
      (await adapter.inspect(setup_.context)).auth.state,
      "signed_out",
    );
    const started = await adapter.startSignIn(setup_.context);
    assert.equal(started.state, "pending");
    assert.ok(started.state === "pending");
    assert.equal(
      started.url,
      "https://auth.openai.com/authorize?state=fixture",
    );
    // The fixture reports the login as completed shortly after it starts.
    await started.done;
    assert.ok(changes >= 1);
    assert.equal(
      (await adapter.inspect(setup_.context)).auth.state,
      "signed_in",
    );
  });
  await withAdapter(
    { signedIn: false, loginUrl: "https://evil.example/login" },
    async (other, rogue) => {
      await assert.rejects(
        other.startSignIn(rogue.context),
        /unsupported sign-in URL/,
      );
    },
  );
});

test("the shared process closes when idle and stays closed after shutdown", async () => {
  const setup_ = await setup({ idleMs: 50 });
  const adapter = setup_.make();
  const session = await setup_.open(adapter);
  await run(session, "Hello");
  session.close();
  await wait(200);
  // The next use starts a new process.
  await adapter.inspect(setup_.context);
  assert.equal(
    (await setup_.log()).filter((entry) => entry.type === "launch").length,
    2,
  );
  adapter.close();
});

const agentEvents = (events: SessionEvent[], key?: string) =>
  events.filter(
    (event): event is Extract<SessionEvent, { type: "agent" }> =>
      event.type === "agent" && (!key || event.key === key),
  );
const until = async (check: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

test("sub-agent threads register under their parent, and their approvals outlive the lead's turn", () =>
  withAdapter(async (adapter, setup_) => {
    const heard: SessionEvent[] = [];
    const session = await setup_.open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    const events = await run(session, "FIXTURE_AGENTS");
    const lead = session.sessionId!;
    const keys = [...new Set(agentEvents(heard).map((event) => event.key))];
    // The scout and its nested reader; the stray thread is not this tab's.
    assert.equal(keys.length, 2);
    const [scout, reader] = keys;
    assert.notEqual(scout, lead);
    const scoutEvents = agentEvents(heard, scout);
    assert.equal(scoutEvents[0].status, "running");
    assert.equal(scoutEvents[0].parentKey, undefined);
    assert.ok(scoutEvents.some((event) => event.name === "Scout"));
    assert.ok(scoutEvents.some((event) => event.agentType === "explorer"));
    assert.ok(
      scoutEvents.some(
        (event) =>
          event.description === "Inspect the checkout" &&
          event.model === "fixture-codex-mini",
      ),
    );
    const readerEvents = agentEvents(heard, reader);
    assert.equal(readerEvents[0].parentKey, scout);
    assert.equal(readerEvents.at(-1)?.status, "completed");
    assert.equal(readerEvents.at(-1)?.summary, "A short README.");
    assert.ok(
      heard.some(
        (event) =>
          event.type === "message" &&
          event.agent === reader &&
          event.text === "A short README.",
      ),
    );
    // A request from an unknown thread is still rejected.
    assert.ok(
      (await setup_.answers("stray approval"))[0].result &&
        "error" in
          ((await setup_.answers("stray approval"))[0].result as object),
    );
    // The lead's turn ended while the scout's approval waits.
    assert.match(text(events, "assistant"), /Fixture reply/);
    const approval = heard.find((event) => event.type === "approval");
    assert.equal(approval?.type === "approval" && approval.agent, scout);
    session.respond(
      approval?.type === "approval" ? approval.request : "",
      "accept",
    );
    await until(
      () => agentEvents(heard, scout).at(-1)?.status === "completed",
      "scout completion",
    );
    assert.equal(agentEvents(heard, scout).at(-1)?.summary, "Found README.md.");
    assert.ok(
      heard.some(
        (event) =>
          event.type === "tool" &&
          event.agent === scout &&
          /ls/.test(event.summary),
      ),
    );
    // Codex then wakes the lead with a turn of its own.
    await until(
      () => heard.some((event) => event.type === "turn.completed"),
      "harness turn",
    );
    const woke = heard.slice(
      heard.findIndex((event) => event.type === "turn.started"),
    );
    assert.deepEqual(
      woke.filter((event) => event.type !== "text").map((event) => event.type),
      ["turn.started", "message", "turn.completed"],
    );
    // A follow-up to the finished scout sets its card running again.
    await run(session, "FIXTURE_FOLLOWUP");
    const after = agentEvents(heard, scout)
      .map((event) => event.status)
      .filter(Boolean);
    assert.deepEqual(after.slice(-3), ["completed", "running", "completed"]);
    assert.equal(agentEvents(heard, scout).at(-1)?.summary, "Checked again.");
  }));

test("native spawn activities register children before routing their approvals and transcripts", () =>
  withAdapter(async (adapter, setup_) => {
    const heard: SessionEvent[] = [];
    const session = await setup_.open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    await run(session, "FIXTURE_NATIVE_AGENTS");
    const keys = [...new Set(agentEvents(heard).map((event) => event.key))];
    assert.equal(keys.length, 2);
    const [scout, reader] = keys;
    assert.ok(
      agentEvents(heard, scout).some((event) => event.name === "/root/scout"),
    );
    assert.equal(agentEvents(heard, reader)[0].parentKey, scout);
    assert.equal(agentEvents(heard, reader).at(-1)?.status, "completed");
    assert.ok(!keys.includes(session.sessionId!));
    const approval = heard.find((event) => event.type === "approval");
    assert.equal(approval?.type === "approval" && approval.agent, scout);
    session.respond(
      approval?.type === "approval" ? approval.request : "",
      "accept",
    );
    await until(
      () => agentEvents(heard, scout).at(-1)?.status === "completed",
      "native scout completion",
    );
    assert.equal(agentEvents(heard, scout).at(-1)?.summary, "Found README.md.");
    assert.deepEqual((await setup_.answers("sub-agent approval"))[0].result, {
      decision: "accept",
    });
    assert.ok(
      "error" in ((await setup_.answers("stray approval"))[0].result as object),
    );
  }));

test("the lead's plan updates become steps, and a sub-agent's never do", () =>
  withAdapter(async (adapter, setup_) => {
    const heard: SessionEvent[] = [];
    const session = await setup_.open(
      adapter,
      { planMode: true },
      undefined,
      (event) => heard.push(event),
    );
    const events = await run(session, "Plan", { ...loadout, planMode: true });
    const steps = events.find((event) => event.type === "steps");
    assert.deepEqual(steps?.type === "steps" && steps, {
      type: "steps",
      steps: [{ text: "Inspect the repository", status: "pending" }],
      explanation: "Fixture plan",
    });
    assert.equal(
      heard.some((event) => event.type === "steps"),
      false,
    );
  }));

test("Stop interrupts the lead turn and each running sub-agent turn", () =>
  withAdapter(async (adapter, setup_) => {
    const heard: SessionEvent[] = [];
    const session = await setup_.open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    const turn = run(session, "FIXTURE_AGENTS FIXTURE_SLOW");
    await until(
      () => heard.some((event) => event.type === "approval"),
      "scout approval",
    );
    await session.stop();
    await turn;
    const interrupts = await setup_.requests("turn/interrupt");
    const scout = agentEvents(heard)[0].key;
    assert.deepEqual(
      interrupts.map((entry) => entry.params?.threadId).sort(),
      [session.sessionId, scout].sort(),
    );
    assert.deepEqual((await setup_.answers("sub-agent approval"))[0].result, {
      decision: "cancel",
    });
    await until(
      () => agentEvents(heard, scout).at(-1)?.status === "stopped",
      "stopped scout",
    );
  }));

test("a process exit with no turn reports a crash for the tab", () =>
  withAdapter(async (adapter, setup_) => {
    const heard: SessionEvent[] = [];
    const session = await setup_.open(adapter, {}, undefined, (event) =>
      heard.push(event),
    );
    await run(session, "FIXTURE_AGENTS FIXTURE_EXIT_LATER");
    await until(
      () => heard.some((event) => event.type === "crashed"),
      "crash report",
    );
  }));

test("enabled skills list as slash commands, and a leading /skill attaches the skill", () =>
  withAdapter(async (adapter, fixture) => {
    assert.deepEqual(
      await adapter.commands({ ...fixture.context, cwd: fixture.dir }),
      [{ name: "review", description: "Review changes" }],
    );
    const session = await fixture.open(adapter);
    await run(session, "/review the last commit");
    await run(session, "/unknown stays as typed");
    const inputs = (await fixture.requests("turn/start")).map(
      (request) => request.params!.input,
    );
    assert.deepEqual(inputs, [
      [
        { type: "text", text: "$review the last commit", text_elements: [] },
        {
          type: "skill",
          name: "review",
          path: "/fixture/skills/review/SKILL.md",
        },
      ],
      [{ type: "text", text: "/unknown stays as typed", text_elements: [] }],
    ]);
    session.close();
  }));
