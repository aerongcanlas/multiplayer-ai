// Local JSONL protocol fixture. It never makes network requests or executes model commands.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const threads = new Map();
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
      { reasoningEffort: "medium" },
      { reasoningEffort: "low" },
    ],
    isDefault: true,
  },
];
function finish(threadId, turnId, text, status = "completed") {
  if (text) {
    notify("item/agentMessage/delta", {
      threadId,
      turnId,
      delta: "Inspecting the requested scope...",
    });
    notify("item/completed", {
      threadId,
      turnId,
      item: { type: "agentMessage", id: randomUUID(), text },
    });
  }
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status,
      ...(status === "failed"
        ? { error: { message: "Fixture provider failure" } }
        : {}),
    },
  });
}
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    const { id, method, params = {} } = message;
    if (!method) {
      const held = pending.get(id);
      if (held) {
        pending.delete(id);
        held(message.result?.decision === "accept");
      }
      return;
    }
    const result = (result) => send({ id, result });
    if (method === "initialize") result({ userAgent: "fixture" });
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
        authUrl: "https://auth.openai.com/authorize?state=fixture",
      });
      setTimeout(() => {
        signedIn = true;
        notify("account/login/completed", {
          loginId: "fixture-login",
          success: true,
        });
      }, 100);
    } else if (method === "account/login/cancel") result({});
    else if (method === "account/logout") {
      signedIn = false;
      result({});
    } else if (method === "thread/start") {
      const threadId = randomUUID();
      threads.set(threadId, params);
      result({ thread: { id: threadId } });
    } else if (method === "thread/unsubscribe") {
      threads.delete(params.threadId);
      result({ status: "unsubscribed" });
    } else if (method === "turn/interrupt") {
      finish(params.threadId, params.turnId, "", "interrupted");
      result({});
    } else if (method === "turn/start") {
      const threadId = params.threadId;
      const turnId = randomUUID();
      const prompt = params.input?.[0]?.text ?? "";
      notify("turn/started", { threadId, turn: { id: turnId } });
      result({ turn: { id: turnId, status: "inProgress" } });
      if (prompt.includes("FIXTURE_CANCEL")) return;
      const role = threads
        .get(threadId)
        ?.developerInstructions.match(/You are the (\w+)/)?.[1];
      const complete = () => {
        if (params.outputSchema?.properties?.suggestedPrompts) {
          const settings = threads.get(threadId);
          assert.equal(settings.ephemeral, true);
          assert.equal(settings.sandbox, "read-only");
          assert.equal(settings.approvalPolicy, "never");
          assert.equal(settings.config["features.shell_tool"], false);
          const source = JSON.parse(prompt);
          assert.ok(source.messages.length > 0);
          assert.ok(
            source.messages.every(
              (message) => message.id && message.authorName && message.text,
            ),
          );
          if (prompt.includes("FIXTURE_SUGGESTION_FAILURE"))
            return finish(threadId, turnId, "", "failed");
          if (prompt.includes("FIXTURE_SUGGESTION_INVALID"))
            return finish(
              threadId,
              turnId,
              JSON.stringify({ suggestedPrompts: [] }),
            );
          return finish(
            threadId,
            turnId,
            JSON.stringify({
              actionable: true,
              summary:
                "The selected feedback requests a bounded UI improvement.",
              suggestedPrompts: [
                "Add a dark mode toggle, persist the selected theme, and verify it survives a restart.",
                ...(prompt.includes("FIXTURE_MULTIPLE_PROMPTS")
                  ? [
                      "Verify keyboard navigation and focus visibility for the theme toggle.",
                    ]
                  : []),
              ],
              unresolved: [],
            }),
          );
        } else if (prompt.startsWith("Plan specialist"))
          finish(
            threadId,
            turnId,
            JSON.stringify({
              tasks: [
                {
                  role: "planner",
                  objective: "Inspect repository structure",
                  criteria: "Identify components with source evidence",
                  dependencies: [],
                },
                {
                  role: "validator",
                  objective: "Independently verify findings",
                  criteria: "Check reported files",
                  dependencies: [0],
                },
              ],
            }),
          );
        else if (prompt.startsWith("Review these"))
          finish(
            threadId,
            turnId,
            JSON.stringify({
              currentWork: "Lead reviewed both specialist results.",
              decisions: ["Repository inspected."],
              uncertainties: ["No builds were run."],
              questions: [],
            }),
          );
        else {
          notify("item/completed", {
            threadId,
            turnId,
            item: {
              type: "commandExecution",
              id: randomUUID(),
              command: "git status --short",
              aggregatedOutput: "Fixture command output",
              exitCode: 0,
            },
          });
          finish(
            threadId,
            turnId,
            JSON.stringify({
              summary: `${role} completed the inspection.`,
              succeeded: !prompt.includes("FIXTURE_FAILED_REVIEW"),
              evidence: ["Inspected repository files."],
              uncertainties: ["No builds run."],
            }),
          );
        }
      };
      if (
        prompt.includes("FIXTURE_APPROVAL") &&
        !prompt.startsWith("Review these")
      ) {
        const requestId = randomUUID();
        pending.set(requestId, (accepted) =>
          accepted ? complete() : finish(threadId, turnId, "", "failed"),
        );
        send({
          id: requestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: randomUUID(),
            command: "git status --short",
            reason: "Fixture approval request",
          },
        });
      } else
        setTimeout(
          complete,
          prompt.includes("FIXTURE_SUGGESTION_SLOW") ? 5_000 : 200,
        );
    } else if (id !== undefined)
      send({
        id,
        error: { code: -32601, message: `Unknown fixture method: ${method}` },
      });
  })
  .on("close", () => process.exit(0));
