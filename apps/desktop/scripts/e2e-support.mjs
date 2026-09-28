// Plumbing shared by the Playwright end-to-end scripts: output directories, fixture repositories,
// the Electron launch with error and network capture, snapshot polling, and the run report.
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
export const appDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BUSY = ["running", "awaiting_host"];

export async function outputDirectory(prefix) {
  const output = resolve(
    appDirectory,
    "../../output/playwright",
    `${prefix}${new Date().toISOString().replaceAll(":", "-")}`,
  );
  await mkdir(output, { recursive: true });
  return output;
}

export const git =
  (repository) =>
  (...args) =>
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

/** Creates a one-commit repository; with a README it is committed, otherwise the commit is empty. */
export async function fixtureRepository(path, { readme } = {}) {
  await mkdir(path, { recursive: true });
  const run = git(path);
  run("init");
  if (readme !== undefined) {
    await writeFile(join(path, "README.md"), readme);
    run("add", "README.md");
  }
  run(
    "-c",
    "user.name=Desktop E2E",
    "-c",
    "user.email=desktop@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    ...(readme === undefined ? ["--allow-empty"] : []),
    "-m",
    "Fixture",
  );
  return run;
}

/** The revision, status, and content hashes of a checkout, so a live run can prove it is unchanged. */
export async function fingerprint(repository) {
  const run = git(repository);
  const files = run(
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
    revision: run("rev-parse", "HEAD").trim(),
    status: run("status", "--porcelain"),
    hashes,
  };
}

export function testEnvironment(extra = {}, unset = []) {
  const environment = { ...process.env, MP_E2E: "1", ...extra };
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", ...unset])
    delete environment[key];
  return environment;
}

export const stubOpenDialog = (application, path) =>
  application.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, path);

/** Simulate a crash without leaving Windows child processes holding the test's pipes open. */
export async function crashApplication(application) {
  const child = application.process();
  const closed = new Promise((resolve) => child.once("close", resolve));
  if (process.platform === "win32")
    execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "pipe",
    });
  else child.kill("SIGKILL");
  await closed;
}

/**
 * One scripted run of the app. `launch` may be called again after a close or a kill; `execute`
 * runs the scenario, writes the report, and closes the app.
 */
export function createRun({
  output,
  environment,
  timeout = 15_000,
  untilTimeout = timeout,
  poll = 100,
  executablePath = require("electron"),
  args = [appDirectory],
  consoleErrors = true,
  stderrErrors = false,
  prepare,
}) {
  const errors = [];
  const network = [];
  const checkpoints = [];
  const run = { application: undefined, page: undefined, errors, network };

  const launch = async () => {
    const application = await electron.launch({
      executablePath,
      args,
      cwd: appDirectory,
      env: environment,
      timeout: 30_000,
    });
    run.application = application;
    if (stderrErrors)
      application.process().stderr.on("data", (data) => {
        const value = data.toString();
        if (value.includes("Error:") || value.includes("Unable to load"))
          errors.push(value.trim());
      });
    await prepare?.(application);
    const page = await application.firstWindow();
    run.page = page;
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].showInactive(),
    );
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      const capture =
        typeof consoleErrors === "function" ? consoleErrors() : consoleErrors;
      if (message.type() === "error" && capture) errors.push(message.text());
    });
    page.on("request", (request) => network.push(request.url()));
    await page
      .getByRole("status")
      .filter({ hasText: "Local supervisor connected" })
      .waitFor();
    await page
      .getByRole("heading", { name: "My workspace", exact: true })
      .waitFor();
  };

  const checkpoint = async (label) => {
    checkpoints.push(label);
    console.log(`PASS: ${label}`);
    await writeFile(
      join(output, "latest-snapshot.yml"),
      await run.page.locator("body").ariaSnapshot(),
    );
  };

  const snapshot = async () => {
    const result = await run.page.evaluate(() => window.desktop.getSnapshot());
    assert.equal(result.ok, true, result.error);
    return result.snapshot;
  };

  const until = async (check, label, limit = untilTimeout) => {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      if (await check()) return;
      await wait(poll);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };

  const settled = (tab, label = "the turn to end", limit) =>
    until(
      async () => {
        const current = await tab();
        return current && !BUSY.includes(current.status);
      },
      label,
      limit,
    );

  // Replaces only the native chooser; the button still traverses validated IPC and Git inspection.
  const selectRepository = async (path) => {
    await stubOpenDialog(run.application, path);
    await run.page
      .getByRole("button", { name: "Select repository", exact: true })
      .click();
    await run.page
      .getByRole("button", { name: basename(path), exact: true })
      .waitFor();
  };

  const send = async (text) => {
    const panel = run.page.getByRole("region", { name: "AI tabs" });
    await panel
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(text);
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    // The composer clears after IPC acknowledges the new turn; an old idle snapshot is insufficient.
    await until(
      async () =>
        (await panel
          .getByRole("textbox", { name: "Message", exact: true })
          .inputValue()) === "",
      "the submitted message to be accepted",
    );
  };

  const report = ({ passed, ...fields }) =>
    writeFile(
      join(output, "report.json"),
      JSON.stringify({ passed, checkpoints, errors, ...fields }, null, 2),
    );

  const execute = async (scenario, { cleanup, extra = () => ({}) } = {}) => {
    try {
      await scenario();
      await report({ passed: true, ...extra() });
      console.log(`Artifacts: ${output}`);
    } catch (error) {
      console.error(error);
      console.error("Runtime errors:", errors);
      const { page } = run;
      if (page && !page.isClosed()) {
        await page
          .screenshot({ path: join(output, "failure.png") })
          .catch(() => {});
        await page
          .locator("body")
          .ariaSnapshot()
          .then((text) => writeFile(join(output, "failure-snapshot.yml"), text))
          .catch(() => {});
      }
      await report({ passed: false, failure: String(error), ...extra() });
      console.error(`Artifacts: ${output}`);
      process.exitCode = 1;
    } finally {
      await run.application?.close().catch(() => {});
      await cleanup?.();
    }
  };

  return Object.assign(run, {
    launch,
    checkpoint,
    snapshot,
    until,
    settled,
    selectRepository,
    send,
    execute,
  });
}
