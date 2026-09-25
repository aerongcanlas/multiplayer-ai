// Live Claude Code release check (manual): `node scripts/claude-e2e.mjs --repository <path>`.
// Uses the managed Claude Code download and the machine's existing Claude Code login. It covers
// models, a project skill that asks a question, continuing from native plan mode, and resuming the
// session after an app restart. Writes are declined, so the repository must stay unchanged apart
// from the skill this script adds under an ignored path.
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import assert from "node:assert/strict";
import {
  createRun,
  fingerprint,
  git,
  outputDirectory,
  testEnvironment,
} from "./e2e-support.mjs";

const argument = process.argv.indexOf("--repository");
if (argument < 0)
  throw new Error("Pass --repository <path> to a disposable checkout.");
const repository = resolve(process.argv[argument + 1]);
const output = await outputDirectory("claude-live-");

// A project skill loads through Claude Code's project settings and asks through AskUserQuestion.
const skill = join(repository, ".claude/skills/pick-color/SKILL.md");
await mkdir(dirname(skill), { recursive: true });
await writeFile(
  skill,
  `---
name: pick-color
description: Ask the user to pick a color, then confirm the choice.
---

Use the AskUserQuestion tool to ask "Which color should we use?" with exactly two options, "Red" and
"Blue". Then reply with one sentence that names the chosen color. Do not use any other tool.
`,
);
git(repository)("config", "core.excludesFile", "/dev/null");
await writeFile(join(repository, ".git/info/exclude"), ".claude/\n", {
  flag: "a",
});
const before = await fingerprint(repository);

const run = createRun({
  output,
  environment: testEnvironment(
    { MP_TEST_USER_DATA: join(output, "user-data") },
    ["ANTHROPIC_API_KEY"],
  ),
  timeout: 60_000,
  untilTimeout: 5 * 60_000,
  poll: 500,
  consoleErrors: false,
});
const { launch, checkpoint, snapshot, until, send, selectRepository } = run;
const claude = async () =>
  (await snapshot()).harnesses.find((item) => item.id === "claude");
const tab = async () => (await snapshot()).rooms[0].tabs[0];
const panel = () => run.page.getByRole("region", { name: "AI tabs" });
const settled = () => run.settled(tab);

await run.execute(async () => {
  await launch();
  await selectRepository(repository);
  await panel().getByRole("button", { name: "New tab", exact: true }).click();
  await run.page
    .getByRole("menuitem", { name: "Claude Code", exact: true })
    .click();
  await until(
    async () => (await claude()).program.state === "ready",
    "the managed download",
    20 * 60_000,
  );
  await until(
    async () => (await tab()).status === "idle",
    "a signed-in Claude Code tab",
  );
  const harness = await claude();
  assert.equal(harness.auth.state, "signed_in");
  assert.ok(harness.models.length > 0);
  await checkpoint(
    `Managed Claude Code ${harness.program.version} is ready with the existing login (${harness.auth.plan ?? "subscription"}), ${harness.models.length} models`,
  );

  await send("/pick-color");
  const question = panel()
    .getByRole("form", { name: "Harness question" })
    .last();
  await question
    .getByRole("radio", { name: /Blue/ })
    .check({ timeout: 5 * 60_000 });
  await question
    .getByRole("button", { name: "Send answer", exact: true })
    .click();
  await settled();
  await panel()
    .locator(".turn-assistant")
    .filter({ hasText: /Blue/i })
    .last()
    .waitFor();
  await checkpoint(
    "A project skill's question appears as a card and the answer reaches the skill",
  );

  await panel().getByRole("checkbox", { name: "Plan mode" }).check();
  await until(async () => (await tab()).loadout.planMode, "plan mode");
  await send(
    "Plan, in two short steps, how you would add a CONTRIBUTING.md with one sentence. When the plan is ready, exit plan mode.",
  );
  const continueButton = panel()
    .getByRole("region", { name: "Plan" })
    .getByRole("button", { name: "Continue into execution" })
    .last();
  await continueButton.waitFor({ timeout: 5 * 60_000 });
  await continueButton.click();
  // Continuing switches to ask mode; the write it then requests is declined.
  const end = Date.now() + 5 * 60_000;
  while (Date.now() < end) {
    const current = await tab();
    if (!["running", "awaiting_host"].includes(current.status)) break;
    const decline = panel()
      .getByRole("region", { name: "Agent approval" })
      .getByRole("button", { name: "Decline" });
    if (await decline.count())
      await decline
        .first()
        .click()
        .catch(() => {});
    await wait(1_000);
  }
  assert.equal((await tab()).loadout.planMode, false);
  await checkpoint("Native plan mode continues into execution from its card");

  const sessionId = (await tab()).sessionId;
  assert.ok(sessionId);
  await run.application.close();
  await launch();
  await until(async () => (await tab())?.status === "idle", "the restored tab");
  await send(
    "Which color did I pick earlier in this conversation? Answer with one word.",
  );
  await settled();
  await panel()
    .locator(".turn-assistant")
    .filter({ hasText: /Blue/i })
    .last()
    .waitFor();
  assert.equal((await tab()).sessionId, sessionId);
  await checkpoint(
    "After a restart the tab resumes the same Claude Code session",
  );

  assert.deepEqual(
    await fingerprint(repository),
    before,
    "The repository must not change",
  );
  assert.deepEqual(run.errors, []);
  await checkpoint(
    "The repository is unchanged and the renderer reported no errors",
  );
});
