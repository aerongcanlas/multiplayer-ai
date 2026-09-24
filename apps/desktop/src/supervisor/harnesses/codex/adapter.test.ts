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
  const context = {
    executable: "/managed/codex",
    // The registry strips provider credentials before any adapter sees the environment.
    env: launchEnvironment({
      PATH: process.env.PATH,
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENAI_API_KEY: "sk-should-not-leak",
      CODEX_API_KEY: "should-not-leak",
    }),
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
  ) =>
    adapter.open({
      ...context,
      tabId: randomUUID(),
      cwd: dir,
      loadout: { ...loadout, ...extra },
      ...(sessionId ? { sessionId } : {}),
    });
  return { dir, make, context, log, requests, answers, open };
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

test("inspect lists fixture models with their efforts and the account", async () => {
  const setup_ = await setup();
  const adapter = setup_.make();
  try {
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
    assert.equal(version, "0.155.1");
  } finally {
    adapter.close();
  }
});

test("a send streams an assistant message on a thread in the tab's checkout with the loadout", async () => {
  const setup_ = await setup();
  const adapter = setup_.make();
  try {
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
  } finally {
    adapter.close();
  }
});

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

test("plan mode uses Codex's native plan mode and continuing uses the default mode", async () => {
  const setup_ = await setup();
  const adapter = setup_.make();
  try {
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
  } finally {
    adapter.close();
  }
});

test("ask mode surfaces approvals and auto mode lets Codex act without asking", async () => {
  const setup_ = await setup();
  const adapter = setup_.make();
  try {
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
  } finally {
    adapter.close();
  }
});

test("user-input requests become questions and MCP forms map onto question cards", async () => {
  const setup_ = await setup();
  const adapter = setup_.make();
  try {
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
  } finally {
    adapter.close();
  }
});

test("Stop cancels pending requests the way Codex expects, then interrupts the turn", async () => {
  const setup_ = await setup();
  const adapter = setup_.make();
  try {
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
  } finally {
    adapter.close();
  }
});

test("a usage limit carries its reset time, and a crashed process restarts on the next send", async () => {
  const setup_ = await setup();
  const adapter = setup_.make();
  try {
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
  } finally {
    adapter.close();
  }
});

test("in-app sign-in returns only allowlisted URLs and reports completion", async () => {
  const setup_ = await setup({ signedIn: false });
  const adapter = setup_.make();
  let changes = 0;
  adapter.onChange(() => changes++);
  try {
    assert.equal(
      (await adapter.inspect(setup_.context)).auth.state,
      "signed_out",
    );
    assert.equal(
      await adapter.startSignIn(setup_.context),
      "https://auth.openai.com/authorize?state=fixture",
    );
    await wait(300);
    assert.ok(changes >= 1);
    assert.equal(
      (await adapter.inspect(setup_.context)).auth.state,
      "signed_in",
    );
  } finally {
    adapter.close();
  }
  const rogue = await setup({
    signedIn: false,
    loginUrl: "https://evil.example/login",
  });
  const other = rogue.make();
  try {
    await assert.rejects(
      other.startSignIn(rogue.context),
      /unsupported sign-in URL/,
    );
  } finally {
    other.close();
  }
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
