// Local Codex app-server fixture speaking the 0.155.1 method names. It never makes network requests
// or runs model commands. Prompt markers select behavior: FIXTURE_APPROVAL, FIXTURE_QUESTION,
// FIXTURE_PERMISSIONS, FIXTURE_ELICIT, FIXTURE_USAGE, FIXTURE_CRASH, FIXTURE_SLOW, and
// FIXTURE_UNKNOWN_REQUEST.
// MP_FIXTURE_STATE persists threads so a restarted fixture can resume them; MP_FIXTURE_LOG records
// every request, the launch arguments, and the environment for tests to inspect.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const statePath = process.env.MP_FIXTURE_STATE;
const logPath = process.env.MP_FIXTURE_LOG;
const threads = new Map(
  statePath && existsSync(statePath)
    ? Object.entries(JSON.parse(readFileSync(statePath, "utf8")))
    : [],
);
const saveThreads = () => {
  if (statePath)
    writeFileSync(statePath, JSON.stringify(Object.fromEntries(threads)));
};
const log = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
log({
  type: "launch",
  argv: process.argv.slice(2),
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|SSH_AUTH_SOCK|HOME|CODEX_HOME|[A-Z_]*API_KEY)$/.test(key),
    ),
  ),
});

const pending = new Map();
let signedIn = process.env.MP_FIXTURE_SIGNED_IN === "1";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ method, params });
const models = [
  {
    id: "fixture-codex",
    model: "fixture-codex",
    displayName: "Fixture Codex",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "low", description: "" },
    ],
    isDefault: true,
  },
];
const running = new Map();

function message(threadId, turnId, text) {
  const itemId = randomUUID();
  const half = Math.ceil(text.length / 2);
  for (const delta of [text.slice(0, half), text.slice(half)])
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta });
  notify("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: itemId, text },
  });
}
function complete(threadId, turnId, status = "completed", error = null) {
  running.delete(threadId);
  notify("turn/completed", {
    threadId,
    turn: { id: turnId, status, error, items: [] },
  });
}
function ask(method, params) {
  const id = randomUUID();
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
function command(threadId, turnId, text) {
  const itemId = randomUUID();
  const item = {
    type: "commandExecution",
    id: itemId,
    command: text,
    cwd: ".",
  };
  notify("item/started", { threadId, turnId, item });
  notify("item/completed", {
    threadId,
    turnId,
    item: { ...item, aggregatedOutput: "Fixture command output", exitCode: 0 },
  });
}

async function turn(threadId, turnId, prompt, params) {
  const thread = threads.get(threadId) ?? { turns: 0 };
  const planMode = params.collaborationMode?.mode === "plan";
  if (prompt.includes("FIXTURE_CRASH")) process.exit(1);
  if (prompt.includes("FIXTURE_SLOW") || prompt.includes("FIXTURE_CANCEL"))
    return;
  if (prompt.includes("FIXTURE_USAGE")) {
    notify("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: 2000000000,
        },
      },
    });
    notify("error", {
      threadId,
      turnId,
      willRetry: false,
      error: {
        message: "You've hit your usage limit.",
        codexErrorInfo: "usageLimitExceeded",
      },
    });
    return complete(threadId, turnId, "failed", {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
    });
  }
  if (prompt.includes("FIXTURE_UNKNOWN_REQUEST")) {
    const result = await ask("item/tool/call", {
      threadId,
      turnId,
      tool: "unknown",
    });
    log({ type: "answer", method: "item/tool/call", result });
  }
  if (prompt.includes("FIXTURE_APPROVAL")) {
    const result = await ask("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: randomUUID(),
      command: "git status --short",
      reason: "Fixture approval request",
    });
    log({
      type: "answer",
      method: "item/commandExecution/requestApproval",
      result,
    });
    if (result?.decision === "cancel") return;
    if (result?.decision === "accept")
      command(threadId, turnId, "git status --short");
    else message(threadId, turnId, "The command was declined.");
  }
  if (prompt.includes("FIXTURE_PERMISSIONS")) {
    const result = await ask("item/permissions/requestApproval", {
      threadId,
      turnId,
      itemId: randomUUID(),
      cwd: ".",
      reason: "Needs network",
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    log({ type: "answer", method: "item/permissions/requestApproval", result });
    if (!result?.permissions?.network) return;
  }
  if (prompt.includes("FIXTURE_QUESTION")) {
    const result = await ask("item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: randomUUID(),
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which scope?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Small", description: "One file" },
            { label: "Large", description: "The module" },
          ],
        },
      ],
    });
    log({ type: "answer", method: "item/tool/requestUserInput", result });
    const answer = result?.answers?.scope?.answers?.[0];
    if (!answer) return;
    message(threadId, turnId, `Scope chosen: ${answer}.`);
  }
  if (prompt.includes("FIXTURE_ELICIT")) {
    const result = await ask("mcpServer/elicitation/request", {
      threadId,
      turnId,
      serverName: "fixture",
      mode: "form",
      _meta: null,
      message: "Pick a region",
      requestedSchema: {
        type: "object",
        properties: {
          region: { type: "string", enum: ["us", "eu"], title: "Region" },
        },
      },
    });
    log({ type: "answer", method: "mcpServer/elicitation/request", result });
  }
  if (planMode) {
    const itemId = randomUUID();
    notify("turn/plan/updated", {
      threadId,
      turnId,
      explanation: "Fixture plan",
      plan: [{ step: "Inspect the repository", status: "pending" }],
    });
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        type: "plan",
        id: itemId,
        text: "1. Inspect the repository\n2. Make the change",
      },
    });
  } else {
    command(threadId, turnId, "git status --short");
    message(
      threadId,
      turnId,
      `Fixture reply (previous turns: ${thread.turns}) with ${params.collaborationMode?.settings?.model}.`,
    );
  }
  thread.turns += 1;
  saveThreads();
  complete(threadId, turnId);
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    const { id, method, params = {} } = message;
    if (!method) {
      const held = pending.get(id);
      if (held) {
        pending.delete(id);
        held(message.result ?? { error: message.error });
      }
      return;
    }
    log({ type: "request", method, params });
    const result = (value) => send({ id, result: value });
    const error = (text) =>
      send({ id, error: { code: -32600, message: text } });
    if (method === "initialize")
      result({
        userAgent: "multiplayer_ai_desktop/0.155.1 (fixture)",
        codexHome: "/tmp/fixture",
        platformFamily: "unix",
        platformOs: "macos",
      });
    else if (method === "account/read")
      result({
        account: signedIn
          ? {
              type: "chatgpt",
              email: "fixture@example.invalid",
              planType: "pro",
            }
          : null,
        requiresOpenaiAuth: true,
      });
    else if (method === "model/list")
      result({ data: models, nextCursor: null });
    else if (method === "account/rateLimits/read")
      result({
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 20,
              windowDurationMins: 300,
              resetsAt: 2000000000,
            },
          },
        },
      });
    else if (method === "account/login/start") {
      result({
        type: "chatgpt",
        loginId: "fixture-login",
        authUrl:
          process.env.MP_FIXTURE_LOGIN_URL ??
          "https://auth.openai.com/authorize?state=fixture",
      });
      setTimeout(() => {
        signedIn = true;
        notify("account/login/completed", {
          loginId: "fixture-login",
          success: true,
          error: null,
        });
      }, 100);
    } else if (method === "account/login/cancel") result({});
    else if (method === "account/logout") {
      signedIn = false;
      result({});
    } else if (method === "thread/start") {
      const threadId = randomUUID();
      threads.set(threadId, { turns: 0, cwd: params.cwd });
      saveThreads();
      result({
        thread: { id: threadId },
        model: params.model ?? "fixture-codex",
      });
    } else if (method === "thread/resume") {
      if (!threads.has(params.threadId))
        return error(`no rollout found for thread id ${params.threadId}`);
      result({ thread: { id: params.threadId }, model: "fixture-codex" });
    } else if (method === "turn/interrupt") {
      result({});
      complete(params.threadId, params.turnId, "interrupted");
    } else if (method === "turn/start") {
      const threadId = params.threadId;
      const turnId = randomUUID();
      const prompt = params.input?.[0]?.text ?? "";
      running.set(threadId, turnId);
      notify("turn/started", {
        threadId,
        turn: { id: turnId, status: "inProgress", items: [] },
      });
      result({ turn: { id: turnId, status: "inProgress", items: [] } });
      void turn(threadId, turnId, prompt, params);
    } else if (id !== undefined) error(`Unknown fixture method: ${method}`);
  })
  .on("close", () => process.exit(0));
