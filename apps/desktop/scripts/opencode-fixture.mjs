// A stand-in for the `opencode` CLI in tests and E2E runs. `acp` speaks ACP over stdio and answers
// prompts by the FIXTURE_* marker they contain; `debug config`, `models --verbose`, and `--version`
// print what the real CLI would. Every request is appended to MP_FIXTURE_LOG as one JSON line.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
} from "@agentclientprotocol/sdk";

const [command, ...rest] = process.argv.slice(2);
const env = process.env;
const injected = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");

// E2E runs share one environment with the Codex fixture, so OpenCode has its own log variable.
const logFile = env.MP_OPENCODE_FIXTURE_LOG || env.MP_FIXTURE_LOG;
function log(entry) {
  if (!logFile) return;
  appendFileSync(
    logFile,
    `${JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      ...entry,
    })}\n`,
  );
}

// The host's own config: MP_FIXTURE_HOST_CONFIG, with a project `opencode.json` over it.
function hostConfig(cwd) {
  const global = JSON.parse(env.MP_FIXTURE_HOST_CONFIG || "{}");
  const file = join(cwd, "opencode.json");
  if (!existsSync(file)) return global;
  const project = JSON.parse(readFileSync(file, "utf8"));
  return {
    ...global,
    ...project,
    provider: { ...global.provider, ...project.provider },
  };
}

// Models the host configured (MP_FIXTURE_MODELS), injected local ones, and OpenCode's anonymous
// free model unless its provider is disabled.
function models() {
  const list = JSON.parse(env.MP_FIXTURE_MODELS || "[]");
  for (const [provider, block] of Object.entries(injected.provider ?? {}))
    for (const [id, model] of Object.entries(block.models ?? {}))
      list.push({ id: `${provider}/${id}`, name: model.name ?? id });
  if (!(injected.disabled_providers ?? []).includes("opencode"))
    list.push({ id: "opencode/fixture-free", name: "Fixture Free" });
  return list;
}

if (command === "--version") {
  console.log("1.18.34");
  process.exit(0);
}
if (command === "debug" && rest[0] === "config") {
  log({ cli: "debug config", content: env.OPENCODE_CONFIG_CONTENT ?? null });
  console.log(JSON.stringify(hostConfig(process.cwd()), null, 2));
  process.exit(0);
}
if (command === "models") {
  log({ cli: "models", content: env.OPENCODE_CONFIG_CONTENT ?? null });
  for (const model of models()) {
    console.log(model.id);
    console.log(
      JSON.stringify(
        {
          id: model.id.split("/").slice(1).join("/"),
          name: model.name,
          variants: Object.fromEntries(
            (model.variants ?? []).map((name) => [name, {}]),
          ),
        },
        null,
        2,
      ),
    );
  }
  process.exit(0);
}
if (command !== "acp") {
  console.error(`The fixture does not support ${command}.`);
  process.exit(2);
}

log({
  start: true,
  argv: process.argv.slice(2),
  passwordLength: env.OPENCODE_SERVER_PASSWORD?.length ?? 0,
  password: env.OPENCODE_SERVER_PASSWORD ?? null,
  autoupdate: env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
  content: env.OPENCODE_CONFIG_CONTENT ?? null,
  permission: env.OPENCODE_PERMISSION ?? null,
  providerKeys: Object.keys(env).filter((key) =>
    /(API_KEY|AUTH_TOKEN)$/.test(key),
  ),
});

// Sessions outlive one process, as OpenCode keeps them on disk.
const stateFile = logFile ? `${logFile}.sessions` : null;
const known = new Set(
  stateFile && existsSync(stateFile)
    ? readFileSync(stateFile, "utf8").split("\n").filter(Boolean)
    : [],
);
const sessions = new Map();
let counter = 0;

const OPTIONS = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];

function configOptions(state) {
  const list = models();
  const current = list.find((model) => model.id === state.model);
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.model,
      options: list
        // A model the catalog has not loaded yet (OpenCode issue #52926).
        .filter((model) => model.id !== "fixture/late" || state.lateLoaded)
        .map((model) => ({ value: model.id, name: model.name })),
    },
    ...(current?.variants?.length
      ? [
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: state.effort ?? "default",
            options: [...current.variants, "default"].map((value) => ({
              value,
              name: value,
            })),
          },
        ]
      : []),
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: state.mode,
      options: [
        { value: "build", name: "build" },
        { value: "plan", name: "plan" },
      ],
    },
  ];
}

function open(sessionId, cwd) {
  const list = models();
  const state = {
    id: sessionId,
    cwd,
    model: injected.model ?? list[0]?.id ?? "unknown/unknown",
    mode: "build",
    effort: undefined,
    lateLoaded: false,
    lateTries: 0,
    cancel: null,
  };
  sessions.set(sessionId, state);
  return state;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection((connection) => {
  const update = (sessionId, value) =>
    connection.sessionUpdate({ sessionId, update: value });
  const text = (sessionId, value, kind = "agent_message_chunk") =>
    update(sessionId, {
      sessionUpdate: kind,
      content: { type: "text", text: value },
    });
  const commands = (sessionId) =>
    setTimeout(
      () =>
        void update(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "review", description: "Review the changes" },
            { name: "bad name", description: "Not completable" },
          ],
        }),
      0,
    );
  const permission = (sessionId, toolCall) =>
    connection.requestPermission({ sessionId, toolCall, options: OPTIONS });

  return {
    async initialize(params) {
      log({ method: "initialize", params });
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
        },
        authMethods: [],
        agentInfo: { name: "OpenCode", version: "1.18.34" },
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params) {
      log({ method: "session/new", params });
      const id = `ses_fixture_${process.pid}_${++counter}`;
      known.add(id);
      if (stateFile) writeFileSync(stateFile, [...known].join("\n"));
      const state = open(id, params.cwd);
      commands(id);
      return { sessionId: id, configOptions: configOptions(state) };
    },
    async resumeSession(params) {
      log({ method: "session/resume", params });
      if (!known.has(params.sessionId))
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `session not found: ${params.sessionId}`,
        );
      const state = open(params.sessionId, params.cwd);
      commands(params.sessionId);
      return { configOptions: configOptions(state) };
    },
    async setSessionConfigOption(params) {
      log({ method: "session/set_config_option", params });
      const state = sessions.get(params.sessionId);
      if (!state) throw RequestError.invalidParams({}, "session not found");
      if (params.configId === "model") {
        if (params.value === "fixture/late" && !state.lateLoaded) {
          state.lateTries++;
          // The catalog loads on the second attempt unless the env keeps it missing.
          if (state.lateTries > 1 && !env.MP_FIXTURE_LATE_NEVER)
            state.lateLoaded = true;
          else
            throw RequestError.invalidParams(
              {},
              `model not found: ${params.value}`,
            );
        } else if (!models().some((model) => model.id === params.value))
          throw RequestError.invalidParams(
            {},
            `model not found: ${params.value}`,
          );
        state.model = params.value;
      } else if (params.configId === "mode") state.mode = params.value;
      else if (params.configId === "effort") state.effort = params.value;
      else throw RequestError.invalidParams({}, "unknown config option");
      return { configOptions: configOptions(state) };
    },
    async cancel(params) {
      log({ method: "session/cancel", params });
      sessions.get(params.sessionId)?.cancel?.();
    },
    async prompt(params) {
      log({ method: "session/prompt", params });
      const id = params.sessionId;
      const state = sessions.get(id);
      if (!state) throw RequestError.invalidParams({}, "session not found");
      const prompt = params.prompt
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      let cancelled = false;
      const cancel = new Promise((resolve) => {
        state.cancel = () => {
          cancelled = true;
          resolve();
        };
      });
      const answer = async (toolCall) => {
        const response = await permission(id, toolCall);
        log({ answered: toolCall.toolCallId, response });
        return response.outcome.outcome === "selected"
          ? response.outcome.optionId
          : "cancelled";
      };
      if (prompt.includes("FIXTURE_AUTH"))
        throw RequestError.authRequired(
          { providerId: "ollama" },
          "provider authentication required",
        );
      if (prompt.includes("FIXTURE_FAIL"))
        throw RequestError.internalError({}, "The fixture provider failed.");
      if (prompt.includes("FIXTURE_CRASH")) {
        await text(id, "Partial ");
        await wait(20);
        process.exit(3);
      }
      if (prompt.includes("FIXTURE_SLOW")) {
        await text(id, "Working");
        await Promise.race([cancel, wait(30_000)]);
        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }
      if (prompt.includes("FIXTURE_THOUGHT"))
        await text(id, "Thinking it over", "agent_thought_chunk");
      if (
        prompt.includes("FIXTURE_TOOL") ||
        prompt.includes("FIXTURE_DENIED")
      ) {
        const denied = prompt.includes("FIXTURE_DENIED");
        const command = denied ? "rm -rf build" : "ls";
        await update(id, {
          sessionUpdate: "tool_call",
          toolCallId: "call_tool",
          title: command,
          kind: "execute",
          status: "pending",
          rawInput: { command },
        });
        await update(id, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_tool",
          status: denied ? "failed" : "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: denied
                  ? "The user has specified a rule which prevents you from using this specific tool call."
                  : "a.txt\nb.txt",
              },
            },
          ],
        });
      }
      if (prompt.includes("FIXTURE_PERMISSION")) {
        await update(id, {
          sessionUpdate: "tool_call",
          toolCallId: "call_bash",
          title: "touch made.txt",
          kind: "execute",
          status: "pending",
          rawInput: { command: "touch made.txt" },
        });
        const choice = await Promise.race([
          answer({
            toolCallId: "call_bash",
            title: "touch made.txt",
            kind: "execute",
            status: "pending",
            rawInput: { command: "touch made.txt" },
          }),
          cancel.then(() => "cancelled"),
        ]);
        if (cancelled || choice === "cancelled")
          return { stopReason: "cancelled" };
        await text(id, choice === "reject" ? "Declined." : "Approved.");
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_EXTERNAL")) {
        const choice = await answer({
          toolCallId: "call_external",
          title: "/etc",
          kind: "other",
          status: "pending",
          rawInput: { filepath: "/etc/hosts", parentDir: "/etc" },
        });
        await text(id, `External ${choice}.`);
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_FOREIGN")) {
        const response = await connection.requestPermission({
          sessionId: "ses_unknown",
          toolCall: {
            toolCallId: "call_foreign",
            title: "rm -rf /",
            kind: "execute",
            status: "pending",
          },
          options: OPTIONS,
        });
        log({ answered: "call_foreign", response });
        await text(
          id,
          `Foreign ${response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled"}.`,
        );
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_LOADOUT")) {
        await text(
          id,
          `model=${state.model} mode=${state.mode} effort=${state.effort ?? "none"}`,
        );
        return { stopReason: "end_turn" };
      }
      await text(id, "Hello ");
      await text(id, "world.");
      if (prompt.includes("FIXTURE_MAX_TOKENS"))
        return { stopReason: "max_tokens" };
      return { stopReason: "end_turn" };
    },
  };
}, stream);
