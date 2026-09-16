import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const argument = process.argv.indexOf("--repository");
if (live && argument < 0)
  throw new Error(
    "A live test requires an explicitly supplied --repository path.",
  );
const output = resolve(
  appDirectory,
  "../../output/playwright",
  `codex-${live ? "live-" : ""}${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(output, { recursive: true });
const repository = live
  ? resolve(process.argv[argument + 1])
  : join(output, "repository");
const git = (...args) =>
  execFileSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-C",
      repository,
      ...args,
    ],
    { windowsHide: true, stdio: "pipe" },
  ).toString();
if (!live) {
  await mkdir(repository);
  git("init");
  await writeFile(join(repository, "README.md"), "Desktop Codex fixture\n");
  git("add", "README.md");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Fixture",
  );
}
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
  for (const path of files) {
    try {
      hashes[path] = createHash("sha256")
        .update(await readFile(join(repository, path)))
        .digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hashes[path] = "missing";
    }
  }
  return {
    revision: git("rev-parse", "HEAD").trim(),
    status: git("status", "--porcelain"),
    hashes,
  };
}
const before = await fingerprint();
const checks = [];
const errors = [];
let application;
let page;
const environment = {
  ...process.env,
  MP_E2E: "1",
  MP_TEST_USER_DATA: join(output, "user-data"),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
if (!live)
  environment.MP_TEST_CODEX_FIXTURE = join(
    appDirectory,
    "scripts/codex-fixture.mjs",
  );
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("heading", { name: "My workspace", exact: true })
    .waitFor();
  await page.locator("body").ariaSnapshot();
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, repository);
}
async function snapshot() {
  const result = await page.evaluate(() => window.desktop.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}
async function checkpoint(label) {
  checks.push(label);
  console.log(`PASS: ${label}`);
}
async function terminal() {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < (live ? 9 * 60_000 : 30_000)) {
    const state = await snapshot();
    const run = state.rooms[0].executions.at(-1);
    if (live && run?.approvals?.length) {
      await page.screenshot({ path: join(output, "approval-required.png") });
      throw new Error(
        "Live execution requires host approval. Inspect the app approval request before continuing.",
      );
    }
    if (run) {
      const status = run.tasks
        .map((task) => `${task.role}:${task.status}`)
        .join(", ");
      if (status !== last) {
        console.log(`PROGRESS: ${status}`);
        last = status;
      }
      if (run.status !== "running") return { state, run };
    }
    await new Promise((resolve) => setTimeout(resolve, live ? 2000 : 100));
  }
  throw new Error("Execution did not complete within the test deadline.");
}
try {
  await launch();
  await page
    .getByRole("button", { name: "Connect ChatGPT", exact: true })
    .click();
  await page.locator("summary").filter({ hasText: "Run settings" }).click();
  await page
    .getByRole("combobox", { name: "Agent model", exact: true })
    .waitFor({ timeout: 60_000 });
  await page
    .getByRole("button", { name: "Select repository", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Agent access", exact: true })
    .selectOption("read-only");
  await page.locator("summary").filter({ hasText: "Run settings" }).click();
  const connected = await snapshot();
  assert.equal(connected.provider.status, "connected");
  await checkpoint(
    "ChatGPT connection exposes available models through the desktop bridge",
  );
  const prompt = live
    ? "Read-only onboarding inspection of nbarchive. Use exactly two specialists: a planner to identify the frontend and backend entry points, and an independent validator to check those findings against source files. Return a short architecture summary with file references and explain how the frontend reaches the backend. Read README and applicable AGENTS.md. Do not modify files, run tests/builds, install dependencies, access credential files, call external services, or use Supabase/Vercel APIs. Keep this to a small inspection."
    : "Inspect the repository with a planner and independent validator.";
  await page
    .getByRole("textbox", { name: "Agent direction", exact: true })
    .fill(prompt);
  await page.getByRole("button", { name: "Run agents", exact: true }).click();
  const { state, run } = await terminal();
  await writeFile(
    join(output, "execution.json"),
    JSON.stringify({ run, summaries: state.rooms[0].summaries }, null, 2),
  );
  assert.equal(run.status, "completed", run.events.at(-1)?.message);
  assert.ok(run.tasks.some((task) => task.role !== "lead"));
  assert.ok(run.tasks.some((task) => task.role === "validator"));
  assert.ok(run.evidence.some((item) => item.kind === "review"));
  assert.ok(state.rooms[0].summaries.length);
  await checkpoint(
    "Lead delegates specialist sessions, receives evidence, and publishes a summary",
  );
  await page.screenshot({ path: join(output, "completed.png") });
  await writeFile(
    join(output, "completed.yml"),
    await page.locator("body").ariaSnapshot(),
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 720),
  );
  await page.screenshot({ path: join(output, "minimum-window.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await checkpoint("Agent controls fit the minimum desktop window");
  if (!live) {
    await page
      .getByRole("textbox", { name: "Agent direction", exact: true })
      .fill("FIXTURE_APPROVAL");
    await page.getByRole("button", { name: "Run agents", exact: true }).click();
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    assert.equal((await terminal()).run.status, "failed");
    await checkpoint(
      "Host can decline a requested command through the real Electron UI",
    );
    await page
      .getByRole("textbox", { name: "Agent direction", exact: true })
      .fill("FIXTURE_CANCEL");
    await page.getByRole("button", { name: "Run agents", exact: true }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    assert.equal((await terminal()).run.status, "cancelled");
    await checkpoint("Stop cancels an active provider turn");
  }
  assert.deepEqual(await fingerprint(), before);
  await checkpoint(
    "Repository revision, status, and tracked/untracked file contents are unchanged",
  );
  await application.close();
  application = undefined;
  await launch();
  const restored = await snapshot();
  assert.equal(restored.rooms[0].executions[0].id, run.id);
  assert.equal(restored.rooms[0].executions[0].status, "completed");
  await checkpoint("Completed agent history survives desktop restart");
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        live,
        checks,
        errors,
        repositoryRevision: before.revision,
        fileCount: Object.keys(before.hashes).length,
      },
      null,
      2,
    ),
  );
  console.log(`REPORT: ${join(output, "report.json")}`);
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error));
  if (page) {
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
    await writeFile(
      join(output, "failure-snapshot.json"),
      JSON.stringify(await snapshot().catch(() => null), null, 2),
    );
  }
  throw error;
} finally {
  if (application) await application.close();
}
