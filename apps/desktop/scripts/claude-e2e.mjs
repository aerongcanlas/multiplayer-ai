// Live Claude Code release check (manual): `node scripts/claude-e2e.mjs --repository <path>`.
// Uses the managed Claude Code download and the machine's existing Claude Code login. It covers
// models, a project skill that asks a question, continuing from native plan mode, and resuming the
// session after an app restart. Writes are declined, so the repository must stay unchanged apart
// from the skill this script adds under an ignored path.
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.indexOf("--repository");
if (argument < 0)
  throw new Error("Pass --repository <path> to a disposable checkout.");
const repository = resolve(process.argv[argument + 1]);
const output = resolve(
  appDirectory,
  "../../output/playwright",
  `claude-live-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(output, { recursive: true });
const git = (...args) =>
  execFileSync("git", ["-C", repository, ...args], {
    stdio: "pipe",
  }).toString();

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
execFileSync("git", [
  "-C",
  repository,
  "config",
  "core.excludesFile",
  "/dev/null",
]);
await writeFile(join(repository, ".git/info/exclude"), ".claude/\n", {
  flag: "a",
});
async function fingerprint() {
  const files = git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const hashes = {};
  for (const path of files)
    hashes[path] = createHash("sha256")
      .update(await readFile(join(repository, path)))
      .digest("hex");
  return {
    revision: git("rev-parse", "HEAD").trim(),
    status: git("status", "--porcelain"),
    hashes,
  };
}
const before = await fingerprint();
const environment = {
  ...process.env,
  MP_E2E: "1",
  MP_TEST_USER_DATA: join(output, "user-data"),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
delete environment.ANTHROPIC_API_KEY;

const checkpoints = [];
const errors = [];
let application;
let page;
const checkpoint = (label) => {
  checkpoints.push(label);
  console.log(`PASS: ${label}`);
};
async function snapshot() {
  const result = await page.evaluate(() => window.desktop.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}
async function until(check, label, timeout = 5 * 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
const claude = async () =>
  (await snapshot()).harnesses.find((item) => item.id === "claude");
const tab = async () => (await snapshot()).rooms[0].tabs[0];
const panel = () => page.getByRole("region", { name: "AI tabs" });
const settled = () =>
  until(
    async () => !["running", "awaiting_host"].includes((await tab()).status),
    "the turn to end",
  );
async function send(text) {
  await panel()
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(text);
  await panel().getByRole("button", { name: "Send", exact: true }).click();
}
async function launch() {
  application = await electron.launch({
    executablePath: require("electron"),
    args: [appDirectory],
    cwd: appDirectory,
    env: environment,
    timeout: 30_000,
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("heading", { name: "My workspace", exact: true })
    .waitFor();
}

try {
  await launch();
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, repository);
  await page
    .getByRole("button", { name: "Select repository", exact: true })
    .click();
  await until(
    async () => Boolean((await snapshot()).rooms[0].workspace),
    "the repository",
  );
  await panel().getByRole("button", { name: "New tab", exact: true }).click();
  await page
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
  checkpoint(
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
  checkpoint(
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
  checkpoint("Native plan mode continues into execution from its card");

  const sessionId = (await tab()).sessionId;
  assert.ok(sessionId);
  await application.close();
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
  checkpoint("After a restart the tab resumes the same Claude Code session");

  assert.deepEqual(
    await fingerprint(),
    before,
    "The repository must not change",
  );
  assert.deepEqual(errors, []);
  checkpoint("The repository is unchanged and the renderer reported no errors");
  await writeFile(
    join(output, "report.json"),
    JSON.stringify({ passed: true, checkpoints }, null, 2),
  );
  console.log(`Artifacts: ${output}`);
} catch (error) {
  console.error(error);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      { passed: false, checkpoints, errors, failure: String(error) },
      null,
      2,
    ),
  );
  console.error(`Artifacts: ${output}`);
  process.exitCode = 1;
} finally {
  await application?.close().catch(() => {});
}
