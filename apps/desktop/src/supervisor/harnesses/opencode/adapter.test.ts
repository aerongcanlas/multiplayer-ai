import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { OpenCodeAdapter, parseModels } from "./adapter";
import type { Discovery } from "./discovery";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessSession,
  type SessionEvent,
} from "../contract";
import { launchEnvironment } from "../environment";
import { Accounts } from "../accounts";
import { HarnessRegistry } from "../registry";
import { ProgramManager } from "../../programs/manager";
import { HARNESS_MANIFEST } from "../../programs/manifest";
import type { Loadout } from "../../../shared/tabs";

const fixture = resolve(
  import.meta.dirname,
  "../../../../scripts/opencode-fixture.mjs",
);
const MODEL = "ollama/qwen3-coder:30b";
const loadout: Loadout = {
  harness: "opencode",
  model: MODEL,
  planMode: false,
  access: "ask",
};
const local = (models = ["qwen3-coder:30b"]): Discovery => ({
  servers: [
    {
      id: "ollama",
      label: "Ollama",
      running: models.length > 0,
      models: models.map((id) => ({ id, name: id, context: 65_536 })),
    },
    { id: "lmstudio", label: "LM Studio", running: false, models: [] },
  ],
  providers: models.length
    ? [
        {
          id: "ollama",
          name: "Ollama",
          baseURL: "http://127.0.0.1:11434/v1",
          models: models.map((id) => ({ id, name: id, context: 65_536 })),
        },
      ]
    : [],
});

async function setup(
  options: {
    env?: Record<string, string>;
    discovery?: Discovery;
    stopTimeoutMs?: number;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-opencode-adapter-"));
  const cwd = join(dir, "repo");
  await mkdir(cwd);
  const logFile = join(dir, "log.jsonl");
  const discovery = { current: options.discovery ?? local() };
  const make = () =>
    new OpenCodeAdapter({
      stopTimeoutMs: options.stopTimeoutMs ?? 2_000,
      discover: async () => discovery.current,
      launcher: (_executable, args, env) => ({
        executable: process.execPath,
        args: [fixture, ...args],
        env: { ...env, MP_FIXTURE_LOG: logFile, ...options.env },
      }),
    });
  const context = {
    executable: "/managed/opencode",
    // The registry strips provider credentials before any adapter sees the environment.
    env: launchEnvironment({
      PATH: process.env.PATH,
      XDG_DATA_HOME: join(dir, "data"),
      OPENAI_API_KEY: "sk-should-not-leak",
    }),
    home: join(dir, "data"),
    hostPaths: {},
  };
  const log = async () =>
    (await readFile(logFile, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const requests = async (method: string) =>
    (await log()).filter((entry) => entry.method === method) as {
      pid: number;
      params: Record<string, unknown>;
    }[];
  const permissions = async () =>
    (await log()).filter((entry) => entry.answered) as {
      answered: string;
      response: { outcome: { outcome: string; optionId?: string } };
    }[];
  const open = (
    adapter: OpenCodeAdapter,
    extra: {
      sessionId?: string;
      listener?: (event: SessionEvent) => void;
    } = {},
  ) =>
    adapter.open({
      ...context,
      tabId: randomUUID(),
      cwd,
      loadout,
      ...extra,
    });
  return {
    dir,
    cwd,
    make,
    context,
    log,
    requests,
    permissions,
    open,
    discovery,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
type Body = (adapter: OpenCodeAdapter, fixture: Fixture) => Promise<void>;
async function withAdapter(body: Body): Promise<void>;
async function withAdapter(
  options: Parameters<typeof setup>[0],
  body: Body,
): Promise<void>;
async function withAdapter(
  options: Parameters<typeof setup>[0] | Body,
  body?: Body,
) {
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

const texts = (events: HarnessEvent[], kind = "assistant") =>
  events.flatMap((event) =>
    event.type === "text" && event.kind === kind ? [event] : [],
  );

test("a plain prompt streams its chunks into one assistant item and completes", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(session, "Say hello");
    assert.deepEqual(events[0], {
      type: "session",
      sessionId: session.sessionId,
    });
    const chunks = texts(events);
    assert.deepEqual(
      chunks.map((event) => event.type === "text" && event.delta),
      ["Hello ", "world."],
    );
    assert.equal(new Set(chunks.map((event) => event.item)).size, 1);
    const prompt = (await fixture.requests("session/prompt"))[0]!.params;
    assert.deepEqual(prompt.prompt, [{ type: "text", text: "Say hello" }]);
    // The session opened in the tab's folder with no MCP servers of the app's own.
    const opened = (await fixture.requests("session/new"))[0]!.params;
    assert.equal(opened.cwd, fixture.cwd);
    assert.deepEqual(opened.mcpServers, []);
    // Each turn sets the model and mode before prompting.
    const options = (await fixture.requests("session/set_config_option")).map(
      (entry) => [entry.params.configId, entry.params.value],
    );
    assert.deepEqual(options, [
      ["model", MODEL],
      ["mode", "build"],
    ]);
    const start = (await fixture.log()).find((entry) => entry.start)!;
    assert.deepEqual(start.providerKeys, []);
  }));

test("thought chunks become reasoning text", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(session, "FIXTURE_THOUGHT");
    assert.deepEqual(
      texts(events, "reasoning").map(
        (event) => event.type === "text" && event.delta,
      ),
      ["Thinking it over"],
    );
  }));

test("a tool call and its update become one tool entry with output as detail", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(session, "FIXTURE_TOOL then answer");
    const tools = events.filter((event) => event.type === "tool");
    assert.equal(new Set(tools.map((event) => event.item)).size, 1);
    const last = tools.at(-1)!;
    assert.equal(last.type === "tool" && last.summary, "ls");
    assert.equal(last.type === "tool" && last.detail, "a.txt\nb.txt");
    // Text after a tool call starts a new item.
    const items = texts(events).map((event) => event.item);
    assert.equal(items.length, 2);
  }));

test("in ask mode a permission request is an approval; accept allows once and decline rejects (AE4)", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    for (const [decision, option, reply] of [
      ["accept", "once", "Approved."],
      ["decline", "reject", "Declined."],
    ] as const) {
      const events = await run(
        session,
        "FIXTURE_PERMISSION",
        loadout,
        (event) => {
          if (event.type === "approval")
            session.respond(event.request, decision);
        },
      );
      const approval = events.find((event) => event.type === "approval")!;
      assert.equal(
        approval.type === "approval" && approval.summary,
        "Run command: touch made.txt",
      );
      assert.ok(
        texts(events).some(
          (event) => event.type === "text" && event.delta === reply,
        ),
      );
      assert.equal(
        (await fixture.permissions()).at(-1)!.response.outcome.optionId,
        option,
      );
    }
  }));

test("in auto mode a permission request is allowed once with no approval", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(session, "FIXTURE_PERMISSION", {
      ...loadout,
      access: "auto",
    });
    assert.equal(
      events.some((event) => event.type === "approval"),
      false,
    );
    assert.equal(
      (await fixture.permissions())[0]!.response.outcome.optionId,
      "once",
    );
  }));

test("in auto mode access outside the checkout is refused and the turn continues (AE9)", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(session, "FIXTURE_EXTERNAL", {
      ...loadout,
      access: "auto",
    });
    assert.equal(
      events.some((event) => event.type === "approval"),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "notice" &&
          /outside this checkout: \/etc/.test(event.summary),
      ),
    );
    assert.ok(
      texts(events).some(
        (event) => event.type === "text" && event.delta === "External reject.",
      ),
    );
  }));

test("a request for no open session is rejected even beside an auto-mode tab", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(session, "FIXTURE_FOREIGN", {
      ...loadout,
      access: "auto",
    });
    assert.equal(
      events.some((event) => event.type === "approval"),
      false,
    );
    assert.equal(
      (await fixture.permissions())[0]!.response.outcome.optionId,
      "reject",
    );
  }));

test("a command the host denies runs no permission request and the turn completes (AE5)", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(session, "FIXTURE_DENIED", {
      ...loadout,
      access: "auto",
    });
    assert.deepEqual(await fixture.permissions(), []);
    const tool = events.filter((event) => event.type === "tool").at(-1)!;
    assert.equal(tool.type === "tool" && tool.summary, "rm -rf build (failed)");
    assert.ok(texts(events).length > 0);
  }));

test("commands are empty until a session opens in the folder, then follow OpenCode's list", () =>
  withAdapter(async (adapter, fixture) => {
    const request = { ...fixture.context, cwd: fixture.cwd };
    assert.deepEqual(await adapter.commands(request), []);
    await fixture.open(adapter);
    for (let tries = 0; tries < 50; tries++) {
      if ((await adapter.commands(request)).length) break;
      await wait(10);
    }
    // A name the prompt box cannot complete is left out.
    assert.deepEqual(await adapter.commands(request), [
      { name: "review", description: "Review the changes" },
    ]);
    assert.deepEqual(
      await adapter.commands({ ...request, cwd: fixture.dir }),
      [],
    );
  }));

test("Stop during a pending approval cancels it, cancels the session, and ends the turn", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const events = await run(
      session,
      "FIXTURE_PERMISSION",
      loadout,
      async (event) => {
        if (event.type === "approval") await session.stop();
      },
    );
    assert.ok(events.some((event) => event.type === "approval"));
    // The fixture records the answer as its own turn winds down.
    for (
      let tries = 0;
      tries < 100 && !(await fixture.permissions()).length;
      tries++
    )
      await wait(10);
    assert.equal(
      (await fixture.permissions())[0]!.response.outcome.outcome,
      "cancelled",
    );
    assert.equal((await fixture.requests("session/cancel")).length, 1);
  }));

test("Stop before the prompt is answered still cancels the turn", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    const started = Date.now();
    const turn = run(session, "FIXTURE_SLOW");
    await wait(300);
    await session.stop();
    await turn;
    assert.ok(Date.now() - started < 5_000);
    assert.equal((await fixture.requests("session/cancel")).length, 1);
  }));

test("a crash fails the turn, and the next session resumes the stored session on a new process (AE6)", () =>
  withAdapter(async (adapter, fixture) => {
    const crashes: SessionEvent[] = [];
    const session = await fixture.open(adapter, {
      listener: (event) => crashes.push(event),
    });
    await assert.rejects(
      run(session, "FIXTURE_CRASH"),
      (error: HarnessError) => error.kind === "crashed",
    );
    session.close();
    const resumed = await fixture.open(adapter, {
      sessionId: session.sessionId,
    });
    const events = await run(resumed, "Say hello");
    assert.equal(
      events.some((event) => event.type === "session"),
      false,
    );
    const resume = await fixture.requests("session/resume");
    assert.equal(resume.at(-1)!.params.sessionId, session.sessionId);
    const pids = new Set(
      (await fixture.requests("initialize")).map((e) => e.pid),
    );
    assert.equal(pids.size, 2);
  }));

test("an unknown session to resume is resume_failed", () =>
  withAdapter(async (adapter, fixture) => {
    await assert.rejects(
      fixture.open(adapter, { sessionId: "ses_missing" }),
      (error: HarnessError) => error.kind === "resume_failed",
    );
  }));

test("plan mode runs the plan agent and the next turn runs build", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    await run(session, "FIXTURE_LOADOUT", { ...loadout, planMode: true });
    await run(session, "FIXTURE_LOADOUT");
    const modes = (await fixture.requests("session/set_config_option"))
      .filter((entry) => entry.params.configId === "mode")
      .map((entry) => entry.params.value);
    assert.deepEqual(modes, ["plan", "build"]);
  }));

test("a model missing from the first catalog is retried once, then fails by name", async () => {
  await withAdapter(
    {
      env: {
        MP_FIXTURE_MODELS: JSON.stringify([
          { id: "fixture/late", name: "Late" },
        ]),
      },
    },
    async (adapter, fixture) => {
      const session = await fixture.open(adapter);
      const events = await run(session, "FIXTURE_LOADOUT", {
        ...loadout,
        model: "fixture/late",
      });
      assert.ok(
        texts(events).some(
          (event) =>
            event.type === "text" && /model=fixture\/late/.test(event.delta),
        ),
      );
    },
  );
  await withAdapter(
    {
      env: {
        MP_FIXTURE_MODELS: JSON.stringify([
          { id: "fixture/late", name: "Late" },
        ]),
        MP_FIXTURE_LATE_NEVER: "1",
      },
    },
    async (adapter, fixture) => {
      const session = await fixture.open(adapter);
      await assert.rejects(
        run(session, "Hi", { ...loadout, model: "fixture/late" }),
        /does not offer fixture\/late/,
      );
      const tries = (
        await fixture.requests("session/set_config_option")
      ).filter((entry) => entry.params.value === "fixture/late");
      assert.equal(tries.length, 2);
    },
  );
});

test("an auth error is signed_out, a provider error fails, and max_tokens completes with a notice", () =>
  withAdapter(async (adapter, fixture) => {
    const session = await fixture.open(adapter);
    await assert.rejects(
      run(session, "FIXTURE_AUTH"),
      (error: HarnessError) =>
        error.kind === "signed_out" &&
        /opencode auth login/.test(error.message),
    );
    await assert.rejects(
      run(session, "FIXTURE_FAIL"),
      (error: HarnessError) =>
        error.kind === "failed" &&
        /could not finish this turn/.test(error.message),
    );
    const events = await run(session, "FIXTURE_MAX_TOKENS");
    assert.ok(
      events.some(
        (event) =>
          event.type === "notice" && /output limit/.test(event.summary),
      ),
    );
  }));

test("inspect reports no models with guidance when nothing is usable (AE3, AE8)", async () => {
  // OpenCode's anonymous free models stay hidden without its login.
  await withAdapter({ discovery: local([]) }, async (adapter, fixture) => {
    const inspection = await adapter.inspect(fixture.context);
    assert.equal(inspection.auth.state, "signed_out");
    assert.match(
      inspection.auth.message!,
      /No models available.*ollama launch opencode.*opencode auth login/,
    );
    assert.deepEqual(inspection.models, []);
    const content = JSON.parse(
      (await fixture.log()).find((entry) => entry.cli === "models")!
        .content as string,
    );
    assert.deepEqual(content.disabled_providers, ["opencode"]);
  });
  await withAdapter(
    {
      discovery: local([]),
      env: {
        MP_FIXTURE_MODELS: JSON.stringify([
          { id: "opencode/big-pickle", name: "Big Pickle" },
        ]),
      },
    },
    async (adapter, fixture) => {
      assert.equal(
        (await adapter.inspect(fixture.context)).auth.state,
        "signed_out",
      );
    },
  );
});

test("inspect with local models is signed in as Local models and reports the servers", () =>
  withAdapter(
    {
      env: {
        MP_FIXTURE_MODELS: JSON.stringify([
          {
            id: "anthropic/claude",
            name: "Claude",
            variants: ["high", "High Reasoning"],
          },
        ]),
      },
    },
    async (adapter, fixture) => {
      const inspection = await adapter.inspect(fixture.context);
      assert.equal(inspection.auth.state, "signed_in");
      assert.equal(inspection.auth.account, "anthropic, Ollama");
      const claude = inspection.models.find(
        (model) => model.id === "anthropic/claude",
      )!;
      // A variant name the loadout cannot carry is dropped.
      assert.deepEqual(claude.efforts, ["high"]);
      const qwen = inspection.models.find((model) => model.id === MODEL)!;
      assert.equal(qwen.isDefault, true);
      assert.deepEqual(
        inspection.localServers!.map((server) => [server.id, server.running]),
        [
          ["ollama", true],
          ["lmstudio", false],
        ],
      );
      const onlyLocal = await setup();
      const localAdapter = onlyLocal.make();
      try {
        assert.equal(
          (await localAdapter.inspect(onlyLocal.context)).auth.account,
          "Local models",
        );
      } finally {
        localAdapter.close();
      }
    },
  ));

test("the registry snapshot carries OpenCode's local servers", async () => {
  const fixture = await setup();
  const adapter = fixture.make();
  const settings = new Map<string, unknown>();
  const executable = join(fixture.dir, "opencode");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
  settings.set("harness.opencode.executable", executable);
  const registry = new HarnessRegistry({
    adapters: [adapter],
    programs: new ProgramManager({
      root: fixture.dir,
      manifest: HARNESS_MANIFEST,
    }),
    accounts: new Accounts(join(fixture.dir, "accounts")),
    settings: {
      getSetting: <T>(key: string) => settings.get(key) as T | undefined,
      setSetting: (key, value) => settings.set(key, value),
    },
    changed: () => {},
    environmentTimeoutMs: 0,
  });
  registry.setEnvironment(fixture.context.env);
  try {
    await registry.refresh("opencode");
    const state = registry.snapshot()[0]!;
    assert.equal(state.auth.state, "signed_in");
    assert.equal(state.signIn, "guidance");
    assert.equal(state.reportsAgents, false);
    assert.equal(state.noticePending, false);
    assert.deepEqual(state.localServers?.[0]?.models[0]?.id, "qwen3-coder:30b");
  } finally {
    registry.close();
  }
});

test("after a config change a new turn starts at once on a new process while the old one finishes", () =>
  withAdapter(async (adapter, fixture) => {
    const first = await fixture.open(adapter);
    const second = await fixture.open(adapter);
    let approve = () => {};
    const approved = new Promise<void>((resolve) => (approve = resolve));
    const turnA = run(first, "FIXTURE_PERMISSION", loadout, async (event) => {
      if (event.type === "approval") {
        await approved;
        first.respond(event.request, "accept");
      }
    });
    while (
      !(await fixture.log()).some((entry) => entry.method === "session/prompt")
    )
      await wait(10);
    // A refresh finds another local model, so the injected config changes.
    fixture.discovery.current = local(["qwen3-coder:30b", "gemma3:12b"]);
    await adapter.inspect(fixture.context);
    const events = await run(second, "Say hello");
    assert.ok(texts(events).length);
    const starts = (await fixture.log()).filter((entry) => entry.start);
    assert.equal(new Set(starts.map((entry) => entry.pid)).size, 2);
    const oldPid = starts[0]!.pid as number;
    assert.ok(isAlive(oldPid));
    approve();
    await turnA;
    for (let tries = 0; tries < 100 && isAlive(oldPid); tries++) await wait(20);
    assert.equal(isAlive(oldPid), false);
  }));

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("parseModels reads ids and variants from the verbose list", () => {
  assert.deepEqual(
    parseModels(
      'ollama/qwen3:8b\n{\n  "name": "Qwen 3",\n  "variants": {\n    "low": {},\n    "Max Power": {}\n  }\n}\nopenai/gpt-5\n',
    ),
    [
      {
        id: "ollama/qwen3:8b",
        name: "Qwen 3",
        efforts: ["low"],
        defaultEffort: null,
        isDefault: false,
      },
      {
        id: "openai/gpt-5",
        name: "openai/gpt-5",
        efforts: [],
        defaultEffort: null,
        isDefault: false,
      },
    ],
  );
});
