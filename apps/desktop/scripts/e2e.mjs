import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packaged = process.argv.includes("--packaged");
const packagedDirectoryOption = process.argv.indexOf("--packaged-dir");
if (
  packagedDirectoryOption !== -1 &&
  (!packaged ||
    !process.argv[packagedDirectoryOption + 1] ||
    process.argv[packagedDirectoryOption + 1].startsWith("--"))
) {
  throw new Error("Use --packaged --packaged-dir <directory>.");
}
const packagedDirectory = resolve(
  appDirectory,
  packagedDirectoryOption === -1
    ? "release/win-unpacked"
    : process.argv[packagedDirectoryOption + 1],
);
const output = join(
  appDirectory,
  "../../output/playwright",
  new Date().toISOString().replaceAll(":", "-"),
);
const fixture = join(output, "fixture-repo");
const userData = join(output, "user-data");
await mkdir(fixture, { recursive: true });
const git = (...args) =>
  execFileSync("git", ["-C", fixture, ...args], {
    windowsHide: true,
    stdio: "pipe",
  }).toString();
git("init");
git(
  "-c",
  "user.name=Desktop E2E",
  "-c",
  "user.email=desktop@example.invalid",
  "-c",
  "core.hooksPath=/dev/null",
  "commit",
  "--allow-empty",
  "-m",
  "Local validation fixture",
);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const errors = [];
const network = [];
const checkpoints = [];
let application;
let page;
let expectedConsoleErrors = false;

async function launch() {
  application = await electron.launch({
    executablePath: packaged
      ? join(packagedDirectory, "Multiplayer AI.exe")
      : require("electron"),
    args: packaged ? [`--user-data-dir=${userData}`] : [appDirectory],
    cwd: appDirectory,
    env: { ...environment, MP_E2E: "1", MP_TEST_USER_DATA: userData },
    timeout: 30_000,
  });
  application.process().stderr.on("data", (data) => {
    const value = data.toString();
    if (value.includes("Error:") || value.includes("Unable to load"))
      errors.push(value.trim());
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  page.setDefaultTimeout(12_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedConsoleErrors)
      errors.push(message.text());
  });
  page.on("request", (request) => network.push(request.url()));
  await page
    .getByRole("status")
    .filter({ hasText: "Local supervisor connected" })
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
  assert.equal(result.ok, true);
  return result.snapshot;
}

try {
  await launch();
  await page
    .getByRole("heading", { name: "My workspace", exact: true })
    .waitFor();
  await page.screenshot({ path: join(output, "01-empty-desktop.png") });
  const security = await application.evaluate(({ BrowserWindow }) => {
    const prefs =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      contextIsolation: prefs.contextIsolation,
      sandbox: prefs.sandbox,
      nodeIntegration: prefs.nodeIntegration,
      webSecurity: prefs.webSecurity,
    };
  });
  assert.deepEqual(security, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
  });
  const exposed = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    keys: Object.keys(window.desktop).sort(),
  }));
  assert.equal(exposed.require, "undefined");
  assert.equal(exposed.process, "undefined");
  assert.deepEqual(
    exposed.keys,
    [
      "createRoom",
      "signIn",
      "signOut",
      "cancelSignIn",
      "refreshShared",
      "joinRoom",
      "createInvite",
      "createSuggestion",
      "editSuggestion",
      "getSnapshot",
      "onHealth",
      "onSnapshot",
      "protocolVersion",
      "selectWorkspace",
      "sendMessage",
      "startExecution",
      "stopExecution",
      "refreshProvider",
      "connectProvider",
      "cancelProviderLogin",
      "disconnectProvider",
      "respondToApproval",
    ].sort(),
  );
  const malformed = await page.evaluate(async () => {
    const state = await window.desktop.getSnapshot();
    return window.desktop.startExecution({
      roomId: state.snapshot.rooms[0].id,
      prompt: "Invalid",
      scenario: "success",
      command: "whoami",
    });
  });
  assert.deepEqual(malformed, { ok: false, error: "Invalid desktop request." });
  await checkpoint("Electron renderer sandbox and narrow IPC bridge");

  await page.getByRole("button", { name: "New room", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Room name", exact: true })
    .fill("Desktop validation");
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page
    .getByRole("heading", { name: "Desktop validation", exact: true })
    .waitFor();
  // Replace only the native chooser response; the user-facing button still traverses validated IPC and Git inspection.
  await application.evaluate(({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [fixturePath],
    });
  }, fixture);
  await page
    .getByRole("button", { name: "Select repository", exact: true })
    .click();
  await page
    .getByRole("button", { name: "fixture-repo", exact: true })
    .waitFor();
  await checkpoint("Create room and select a real local Git repository");

  await page
    .getByRole("textbox", { name: "Group chat message", exact: true })
    .fill("Keep the existing UI components and verify keyboard navigation.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("checkbox", { name: /Select message: Keep the existing/ })
    .click();
  await page
    .getByRole("button", { name: "Suggest prompts", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Edit suggested prompt", exact: true })
    .fill("Preserve the panel architecture and verify keyboard navigation.");
  await page.getByRole("button", { name: "Save edit", exact: true }).click();
  await page.getByRole("button", { name: "Use prompt", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Agent direction", exact: true })
      .inputValue(),
    "Preserve the panel architecture and verify keyboard navigation.",
  );
  let state = await snapshot();
  assert.equal(
    state.rooms[1].executions.length,
    0,
    "Selecting a suggestion must not dispatch work",
  );
  assert.equal(state.rooms[1].suggestions[0].sources[0].authorName, "You");
  assert.equal(state.rooms[1].suggestions[0].revision, 2);
  await checkpoint(
    "Chat selection, persisted suggestion editing, attribution, and draft-only use",
  );

  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await page
    .getByText("Simulated validation passed", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^lead completed /i }).waitFor();
  state = await snapshot();
  assert.equal(state.rooms[1].executions[0].tasks.length, 4);
  assert.equal(state.rooms[1].executions[0].sourceSuggestion.revision, 2);
  assert.equal(state.rooms[1].summaries[0].version, 1);
  await page.getByRole("button", { name: /validator completed/i }).click();
  await page.getByText("Showing validator activity", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Show all agent activity", exact: true })
    .click();
  await page.screenshot({ path: join(output, "02-completed-workflow.png") });
  await checkpoint(
    "Stream task progress, inspect an agent, and publish versioned context",
  );

  await page
    .getByRole("combobox", { name: "Mock scenario", exact: true })
    .selectOption("validation-failure");
  await page
    .getByRole("textbox", { name: "Agent direction", exact: true })
    .fill("Demonstrate a failed validation.");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await page
    .getByText("Simulated validation failed", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^lead failed /i }).waitFor();
  await checkpoint(
    "Failed validation stays visible and marks the execution failed",
  );

  await page
    .getByRole("textbox", { name: "Agent direction", exact: true })
    .fill("Stop this simulation.");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: /^lead cancelled /i }).waitFor();
  state = await snapshot();
  assert.equal(state.rooms[1].executions.at(-1).status, "cancelled");
  await checkpoint("Stop cancels the active execution and retains its history");

  await page.keyboard.press("Control+b");
  assert.equal(
    await page.getByRole("navigation", { name: "Rooms", exact: true }).count(),
    0,
  );
  await page.keyboard.press("Control+b");
  await page.getByRole("navigation", { name: "Rooms", exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 720),
  );
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll(".panel, .mission-panel")].map(
      (panel) => ({
        height: panel.getBoundingClientRect().height,
        width: panel.getBoundingClientRect().width,
      }),
    ),
  }));
  assert.ok(
    layout.scrollWidth <= layout.width,
    "Window must not overflow horizontally",
  );
  assert.ok(
    layout.panels.every((panel) => panel.height > 120 && panel.width > 200),
  );
  await page.screenshot({ path: join(output, "03-minimum-window.png") });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 960),
  );
  await checkpoint("Keyboard sidebar toggle and usable panels at 1024 by 720");

  await page.reload();
  await page
    .getByRole("heading", { name: "Desktop validation", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "fixture-repo", exact: true })
    .waitFor();
  assert.equal((await snapshot()).rooms[1].messages.length, 1);
  await checkpoint(
    "Reload reconciles persisted room, repository, chat, suggestions, and executions",
  );

  await page
    .getByRole("textbox", { name: "Agent direction", exact: true })
    .fill("Recover this interrupted simulation.");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
  await application.close();
  await launch();
  await page
    .getByText("This execution was interrupted.", { exact: false })
    .waitFor();
  state = await snapshot();
  assert.equal(state.rooms[1].executions.at(-1).status, "blocked");
  assert.equal(state.rooms[1].messages.length, 1);
  assert.equal(state.rooms[1].suggestions[0].revision, 2);
  await checkpoint(
    "Restart recovers interrupted work as blocked without replay",
  );

  // Killing only this application's utility process exercises stale state in the visible product.
  await application.evaluate(({ app }) => {
    const child = app
      .getAppMetrics()
      .find((metric) => metric.name === "Multiplayer AI Supervisor");
    if (!child)
      throw new Error("Supervisor process missing from application metrics");
    process.kill(child.pid);
  });
  await page
    .getByRole("status")
    .filter({ hasText: "Progress is stale" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Run simulation", exact: true })
      .isDisabled(),
    true,
  );
  await page.screenshot({ path: join(output, "04-stale-supervisor.png") });
  await checkpoint("Supervisor loss is visible and prevents dispatch");

  expectedConsoleErrors = true;
  const windowsBefore = application.windows().length;
  await page.evaluate(() => window.open("https://example.invalid", "_blank"));
  assert.equal(application.windows().length, windowsBefore);
  assert.equal(
    git("status", "--porcelain"),
    "",
    "Simulation must not alter the selected repository",
  );
  const remoteRequests = network.filter(
    (url) => !url.startsWith("multiplayer://desktop/"),
  );
  assert.deepEqual(
    remoteRequests,
    [],
    "No network requests outside packaged app assets are allowed",
  );
  assert.deepEqual(errors, [], "No unexpected renderer or main-process errors");
  await checkpoint(
    "No remote requests, no repository changes, and no unexpected runtime errors",
  );
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      { passed: true, checkpoints, security, network, errors },
      null,
      2,
    ),
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
      { passed: false, checkpoints, errors, failure: String(error), network },
      null,
      2,
    ),
  );
  console.error(`Artifacts: ${output}`);
  process.exitCode = 1;
} finally {
  await application?.close().catch(() => {});
}
