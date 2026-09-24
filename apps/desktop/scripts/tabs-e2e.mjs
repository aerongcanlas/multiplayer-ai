// Chat tabs end to end with harness fixtures: managed downloads from a loopback server, Codex and
// Claude Code tabs, approvals, questions, plan mode, Stop, close, suggestions, restart resume, and
// crash recovery. Nothing leaves the machine.
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import assert from "node:assert/strict";
import { startProgramServer } from "./programs-fixture.mjs";

const require = createRequire(import.meta.url);
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(
  appDirectory,
  "../../output/playwright",
  `tabs-${new Date().toISOString().replaceAll(":", "-")}`,
);
const repository = join(output, "repository");
const userData = join(output, "user-data");
const claudeState = join(output, "claude-fixture.json");
const codexLog = join(output, "codex-fixture.jsonl");
await mkdir(repository, { recursive: true });
const git = (...args) =>
  execFileSync("git", ["-C", repository, ...args], {
    windowsHide: true,
    stdio: "pipe",
  }).toString();
git("init");
await writeFile(join(repository, "README.md"), "Tabs fixture\n");
git("add", "README.md");
git(
  "-c",
  "user.name=Desktop E2E",
  "-c",
  "user.email=desktop@example.invalid",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "Fixture",
);
// Claude Code starts signed out to show guidance; the test signs it in later.
await writeFile(claudeState, JSON.stringify({ signedIn: false, sessions: {} }));
const programs = await startProgramServer(join(output, "manifest.json"));
programs.corrupt("claude");

const environment = {
  ...process.env,
  MP_E2E: "1",
  MP_TEST_USER_DATA: userData,
  MP_TEST_CODEX_FIXTURE: join(appDirectory, "scripts/codex-fixture.mjs"),
  MP_TEST_CLAUDE_FIXTURE: claudeState,
  MP_TEST_HARNESS_MANIFEST: join(output, "manifest.json"),
  MP_FIXTURE_SIGNED_IN: "1",
  MP_FIXTURE_STATE: join(output, "codex-threads.json"),
  MP_FIXTURE_LOG: codexLog,
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;

const errors = [];
const network = [];
const checkpoints = [];
let application;
let page;

async function launch() {
  application = await electron.launch({
    executablePath: require("electron"),
    args: [appDirectory],
    cwd: appDirectory,
    env: environment,
    timeout: 30_000,
  });
  // Record, rather than perform, anything that would leave the app window.
  await application.evaluate(({ shell }) => {
    globalThis.external = [];
    shell.openExternal = async (url) => {
      globalThis.external.push(["openExternal", url]);
    };
    shell.openPath = async (path) => {
      globalThis.external.push(["openPath", path]);
      return "";
    };
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => network.push(request.url()));
  await page
    .getByRole("status")
    .filter({ hasText: "Local supervisor connected" })
    .waitFor();
  await page
    .getByRole("heading", { name: "My workspace", exact: true })
    .waitFor();
}

async function checkpoint(label) {
  checkpoints.push(label);
  console.log(`PASS: ${label}`);
  await writeFile(
    join(output, "latest-snapshot.yml"),
    await page.locator("body").ariaSnapshot(),
  );
}

async function snapshot() {
  const result = await page.evaluate(() => window.desktop.getSnapshot());
  assert.equal(result.ok, true, result.error);
  return result.snapshot;
}
async function until(check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
const room = async () => (await snapshot()).rooms[0];
const tabNamed = async (title) =>
  (await room()).tabs.find((tab) => tab.title === title);
const harness = async (id) =>
  (await snapshot()).harnesses.find((item) => item.id === id);
const tabsPanel = () => page.getByRole("region", { name: "AI tabs" });
const settings = () => page.getByRole("region", { name: "Harness settings" });
const harnessRow = (label) =>
  settings().locator(".harness-row").filter({ hasText: label });

async function selectTab(title) {
  await tabsPanel()
    .getByRole("tab", { name: new RegExp(title) })
    .click();
}
async function send(text) {
  const composer = tabsPanel().getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await composer.fill(text);
  await tabsPanel().getByRole("button", { name: "Send", exact: true }).click();
}
async function settled(title) {
  await until(async () => {
    const tab = await tabNamed(title);
    return tab && !["running", "awaiting_host"].includes(tab.status);
  }, `${title} to finish its turn`);
}
async function codexRequests(method) {
  return (await readFile(codexLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "request" && entry.method === method);
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
  await page.getByRole("button", { name: "repository", exact: true }).waitFor();

  // F1 / AE1: the first Codex tab downloads, verifies, and becomes ready.
  await tabsPanel()
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await until(
    async () => (await tabNamed("Codex 1"))?.status === "idle",
    "the Codex tab to become ready",
  );
  assert.equal(programs.requests("codex"), 1);
  assert.equal((await harness("codex")).program.state, "ready");
  assert.equal((await tabNamed("Codex 1")).loadout.model, "fixture-codex");
  // AE3: only the efforts the model reports are offered.
  assert.deepEqual(
    await tabsPanel()
      .getByRole("combobox", { name: "Effort", exact: true })
      .locator("option")
      .allTextContents(),
    ["medium", "low"],
  );
  await checkpoint("A first Codex tab downloads, verifies, and becomes ready");

  // F2 / AE4: an approval card pauses the turn until the host approves.
  await send("FIXTURE_APPROVAL inspect the checkout");
  const approval = tabsPanel().getByRole("region", { name: "Agent approval" });
  await approval.getByText("Run command: git status --short").waitFor();
  assert.equal((await tabNamed("Codex 1")).status, "awaiting_host");
  await page.screenshot({ path: join(output, "01-approval.png") });
  await approval
    .getByRole("button", { name: "Approve once", exact: true })
    .click();
  await settled("Codex 1");
  await tabsPanel().getByText("git status --short (exit 0)").first().waitFor();
  await tabsPanel()
    .getByText(/^Turn completed\./)
    .first()
    .waitFor();
  await checkpoint(
    "An approval card shows, Approve continues, and the tool summary lands",
  );

  // AE8: Stop while an approval is pending ends the turn stopped.
  await send("FIXTURE_APPROVAL again");
  await tabsPanel()
    .getByRole("button", { name: "Approve once", exact: true })
    .waitFor();
  await tabsPanel().getByRole("button", { name: "Stop", exact: true }).click();
  await settled("Codex 1");
  await tabsPanel()
    .getByText(/^Turn stopped by the host\./)
    .waitFor();
  assert.equal(
    await tabsPanel().getByRole("button", { name: "Approve once" }).count(),
    0,
  );
  await checkpoint("Stop while an approval is pending ends the turn stopped");

  // Plan mode uses Codex's native plan mode, then continues into execution.
  await tabsPanel().getByRole("checkbox", { name: "Plan mode" }).check();
  await until(
    async () => (await tabNamed("Codex 1")).loadout.planMode,
    "plan mode",
  );
  await send("Plan the change");
  await settled("Codex 1");
  const plan = tabsPanel().getByRole("region", { name: "Plan" }).last();
  await plan.getByRole("button", { name: "Continue into execution" }).click();
  await settled("Codex 1");
  assert.equal((await tabNamed("Codex 1")).loadout.planMode, false);
  const turns = await codexRequests("turn/start");
  assert.deepEqual(
    turns.slice(-2).map((turn) => turn.params.collaborationMode.mode),
    ["plan", "default"],
  );
  await checkpoint(
    "Codex plan mode yields a plan that continues into execution",
  );

  // A custom path to a bad file shows guidance and never downloads.
  const bad = join(output, "not-a-program.txt");
  await writeFile(bad, "not a program");
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, bad);
  await harnessRow("Codex").locator("summary", { hasText: "Program" }).click();
  await harnessRow("Codex")
    .getByRole("button", { name: "Choose executable…", exact: true })
    .click();
  await until(
    async () => (await harness("codex")).program.state === "custom_invalid",
    "the custom path to be rejected",
  );
  await harnessRow("Codex")
    .getByText(/custom executable is missing or cannot be run/i)
    .waitFor();
  assert.equal(programs.requests("codex"), 1);
  await harnessRow("Codex")
    .getByRole("button", { name: "Use managed program" })
    .first()
    .click();
  await until(
    async () => (await harness("codex")).program.state === "ready",
    "the managed program to be used again",
  );
  assert.equal(programs.requests("codex"), 1);
  await checkpoint("A bad custom executable shows guidance with no download");

  // A corrupted download names the failure and offers retry; Claude Code then needs a login.
  await tabsPanel()
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Claude Code", exact: true })
    .click();
  await until(
    async () => (await harness("claude")).program.state === "failed",
    "the corrupted Claude Code download to fail",
  );
  assert.match((await harness("claude")).program.message, /checksum/);
  await tabsPanel()
    .getByText(/does not match its pinned checksum/)
    .waitFor();
  programs.corrupt("claude", false);
  await tabsPanel()
    .getByRole("button", { name: "Retry download", exact: true })
    .click();
  await until(
    async () => (await harness("claude")).program.state === "ready",
    "the retried download",
  );
  assert.equal(programs.requests("claude"), 2);
  await checkpoint(
    "A corrupted download shows the failure and a working retry",
  );

  // AE2: signed-out Claude Code shows guidance, no sign-in button, and the one-time notice.
  await until(
    async () => (await harness("claude")).auth.state === "signed_out",
    "Claude Code sign-in state",
  );
  await tabsPanel()
    .getByText(/Sign in once with the Claude Code CLI/)
    .waitFor();
  assert.equal(
    await tabsPanel()
      .getByRole("button", { name: /Sign in/ })
      .count(),
    0,
  );
  const notice = tabsPanel().getByRole("note", {
    name: "Claude Code sign-in notice",
  });
  await notice.getByText(/never asks for it/).waitFor();
  await page.screenshot({ path: join(output, "03-claude-signed-out.png") });
  await notice.getByRole("button", { name: "Got it", exact: true }).click();
  await until(
    async () => !(await harness("claude")).noticePending,
    "notice acknowledgement",
  );
  assert.equal(await tabsPanel().getByRole("note").count(), 0);
  await writeFile(
    claudeState,
    JSON.stringify({ signedIn: true, sessions: {} }),
  );
  await harnessRow("Claude Code")
    .getByRole("button", { name: "Refresh Claude Code", exact: true })
    .click();
  await until(
    async () => (await tabNamed("Claude Code 1"))?.status === "idle",
    "the Claude Code tab to become ready",
  );
  await checkpoint(
    "Signed-out Claude Code shows guidance and the one-time notice only",
  );

  // AE7: a skill's question appears as a card and the answer continues the turn.
  await send("/review FIXTURE_ASK");
  const question = tabsPanel().getByRole("form", { name: "Harness question" });
  await question.getByText("Which approach should the skill take?").waitFor();
  await question.getByRole("radio", { name: /Thorough/ }).check();
  await page.screenshot({ path: join(output, "02-question.png") });
  await question
    .getByRole("button", { name: "Send answer", exact: true })
    .click();
  await settled("Claude Code 1");
  await tabsPanel()
    .getByText(/Skill continues with/)
    .waitFor();
  await tabsPanel()
    .getByText(/Thorough/)
    .last()
    .waitFor();
  await checkpoint("A Claude Code skill question card sends its answer back");

  // Claude Code's native plan mode asks before leaving plan mode.
  await tabsPanel().getByRole("checkbox", { name: "Plan mode" }).check();
  await until(
    async () => (await tabNamed("Claude Code 1")).loadout.planMode,
    "plan mode",
  );
  await send("FIXTURE_EXIT_PLAN");
  await tabsPanel()
    .getByRole("region", { name: "Plan" })
    .last()
    .getByRole("button", { name: "Continue into execution" })
    .click();
  await settled("Claude Code 1");
  await tabsPanel().getByText("Implementing the plan.").waitFor();
  assert.equal((await tabNamed("Claude Code 1")).loadout.planMode, false);
  await checkpoint(
    "Claude Code plan mode continues into execution from its card",
  );

  // Two tabs in one room run turns concurrently.
  await send("FIXTURE_SLOW");
  await selectTab("Codex 1");
  await send("FIXTURE_SLOW");
  await until(async () => {
    const tabs = (await room()).tabs;
    return tabs.every((tab) => tab.status === "running");
  }, "both tabs to run");
  await tabsPanel().getByRole("button", { name: "Stop", exact: true }).click();
  await selectTab("Claude Code 1");
  await tabsPanel().getByRole("button", { name: "Stop", exact: true }).click();
  await settled("Codex 1");
  await settled("Claude Code 1");
  await checkpoint("Two tabs run turns concurrently and stop independently");

  // R30: closing a running tab asks for confirmation.
  await tabsPanel()
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await until(
    async () => (await tabNamed("Codex 2"))?.status === "idle",
    "Codex 2",
  );
  await selectTab("Codex 2");
  await send("FIXTURE_SLOW");
  await until(
    async () => (await tabNamed("Codex 2"))?.status === "running",
    "Codex 2 to run",
  );
  await tabsPanel()
    .getByRole("button", { name: "Close Codex 2", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", { name: "Close running tab" });
  await confirm.getByText(/Stop it and close the tab\?/).waitFor();
  assert.ok(await tabNamed("Codex 2"));
  await confirm
    .getByRole("button", { name: "Stop and close", exact: true })
    .click();
  await until(async () => !(await tabNamed("Codex 2")), "Codex 2 to close");
  await checkpoint(
    "Closing a running tab asks for confirmation, then stops and closes it",
  );

  // R5: a room suggestion fills the active tab, and the sent turn shows its source.
  await selectTab("Codex 1");
  await page
    .getByRole("textbox", { name: "Group chat message", exact: true })
    .fill("Keep the README short.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("checkbox", { name: /Select message: Keep the README/ })
    .click();
  await page
    .getByRole("button", { name: "Suggest prompts", exact: true })
    .click();
  await page.getByRole("button", { name: "Use prompt", exact: true }).click();
  const composer = tabsPanel().getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  assert.match(await composer.inputValue(), /Keep the README short/);
  assert.equal((await room()).suggestions[0].status, "draft");
  await tabsPanel().getByRole("button", { name: "Send", exact: true }).click();
  await settled("Codex 1");
  await tabsPanel()
    .getByText(/From a room suggestion · 1 source message/)
    .waitFor();
  assert.equal((await room()).suggestions[0].status, "submitted");
  await checkpoint(
    "A room suggestion fills the active tab and the turn shows its source",
  );

  // AE5: after a restart, a follow-up continues the same Codex thread.
  const threadId = (await tabNamed("Codex 1")).sessionId;
  assert.ok(threadId);
  await application.close();
  await launch();
  await selectTab("Codex 1");
  await until(
    async () => (await tabNamed("Codex 1"))?.status === "idle",
    "Codex after restart",
  );
  await send("Follow up after restart");
  await settled("Codex 1");
  await tabsPanel()
    .getByText(/previous turns: [1-9]/)
    .last()
    .waitFor();
  assert.equal(
    (await codexRequests("thread/resume")).at(-1).params.threadId,
    threadId,
  );
  await checkpoint("After a restart a follow-up continues the fixture session");

  // AE8: killing the app mid-turn leaves the turn interrupted with nothing pending.
  await send("FIXTURE_APPROVAL before the crash");
  await tabsPanel()
    .getByRole("button", { name: "Approve once", exact: true })
    .waitFor();
  application.process().kill("SIGKILL");
  await wait(500);
  await launch();
  await selectTab("Codex 1");
  await until(
    async () => (await tabNamed("Codex 1"))?.status === "interrupted",
    "the interrupted tab",
  );
  await tabsPanel()
    .getByText(/The app restarted during this turn/)
    .waitFor();
  assert.equal(
    await tabsPanel().getByRole("button", { name: "Approve once" }).count(),
    0,
  );
  await checkpoint(
    "Killing the app mid-turn shows the turn interrupted after relaunch",
  );

  // Nothing left the app: no browser, no terminal, no remote requests.
  const external = await application.evaluate(() => globalThis.external);
  assert.deepEqual(external, []);
  assert.deepEqual(
    network.filter(
      (url) =>
        !url.startsWith("multiplayer://desktop/") &&
        !url.startsWith("http://127.0.0.1:5173"),
    ),
    [],
  );
  assert.equal(
    git("status", "--porcelain"),
    "",
    "Fixtures must not change the repository",
  );
  assert.deepEqual(errors, [], "No renderer errors");
  await checkpoint(
    "No external windows, terminals, remote requests, or renderer errors",
  );

  await writeFile(
    join(output, "report.json"),
    JSON.stringify({ passed: true, checkpoints, errors }, null, 2),
  );
  console.log(`Artifacts: ${output}`);
} catch (error) {
  console.error(error);
  console.error("Runtime errors:", errors);
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
    await writeFile(
      join(output, "failure-snapshot.yml"),
      await page.locator("body").ariaSnapshot(),
    ).catch(() => {});
  }
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
  await programs.close();
}
