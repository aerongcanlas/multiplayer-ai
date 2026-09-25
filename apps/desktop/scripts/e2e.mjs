import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { startProgramServer } from "./programs-fixture.mjs";

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
const defaultPackagedDirectory = {
  win32: "release/win-unpacked",
  darwin: `release/mac${process.arch === "arm64" ? "-arm64" : ""}`,
  linux: "release/linux-unpacked",
}[process.platform];
const packagedDirectory = resolve(
  appDirectory,
  packagedDirectoryOption === -1
    ? defaultPackagedDirectory
    : process.argv[packagedDirectoryOption + 1],
);
const packagedExecutable = {
  win32: join(packagedDirectory, "Multiplayer AI.exe"),
  darwin: join(
    packagedDirectory,
    "Multiplayer AI.app/Contents/MacOS/Multiplayer AI",
  ),
  linux: join(packagedDirectory, "multiplayer-ai-desktop"),
}[process.platform];
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
// Unpackaged runs use harness fixtures and a loopback download server; a packaged app ignores them.
const programs = packaged
  ? undefined
  : await startProgramServer(join(output, "manifest.json"));
const environment = {
  ...process.env,
  ...(packaged
    ? {}
    : {
        MP_TEST_CODEX_FIXTURE: join(appDirectory, "scripts/codex-fixture.mjs"),
        MP_TEST_CLAUDE_FIXTURE: join(output, "claude-fixture.json"),
        MP_TEST_HARNESS_MANIFEST: join(output, "manifest.json"),
        MP_FIXTURE_SIGNED_IN: "1",
        MP_FIXTURE_STATE: join(output, "codex-threads.json"),
      }),
};
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
    executablePath: packaged ? packagedExecutable : require("electron"),
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
      "onTranscript",
      "protocolVersion",
      "selectWorkspace",
      "sendMessage",
      "openTab",
      "renameTab",
      "closeTab",
      "setLoadout",
      "sendToTab",
      "stopTab",
      "loadTranscript",
      "loadAgents",
      "resetTabSession",
      "respondToTabApproval",
      "answerQuestion",
      "refreshHarness",
      "signInHarness",
      "chooseHarnessExecutable",
      "useManagedHarness",
      "acknowledgeHarnessNotice",
    ].sort(),
  );
  const malformed = await page.evaluate(async () => {
    const state = await window.desktop.getSnapshot();
    return window.desktop.sendToTab({
      roomId: state.snapshot.rooms[0].id,
      tabId: state.snapshot.rooms[0].id,
      text: "Invalid",
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
  let state = await snapshot();
  assert.equal(state.rooms[1].suggestions[0].sources[0].authorName, "You");
  assert.equal(state.rooms[1].suggestions[0].revision, 2);

  if (packaged) {
    // The Claude Code harness state exists only once the supervisor has loaded the Claude Agent
    // SDK, so reaching it proves the SDK loads from the packaged build.
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Claude Code", exact: true })
      .click();
    await page.getByRole("tab", { name: /Claude Code 1/ }).waitFor();
    state = await snapshot();
    assert.equal(state.rooms[1].tabs[0].status, "unavailable");
    assert.ok(
      ["missing", "downloading"].includes(
        state.harnesses.find((harness) => harness.id === "claude").program
          .state,
      ),
    );
    await checkpoint(
      "A packaged Claude Code tab without a managed binary needs setup",
    );
    await writeFile(
      join(output, "report.json"),
      JSON.stringify({ passed: true, checkpoints, security, errors }, null, 2),
    );
    console.log(`Artifacts: ${output}`);
    process.exit(0);
  }

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await page.getByRole("tab", { name: /Codex 1/ }).waitFor();
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await snapshot()).rooms[1].tabs[0].status === "idle") break;
    await page.waitForTimeout(100);
  }
  await page.getByRole("button", { name: "Use prompt", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    "Preserve the panel architecture and verify keyboard navigation.",
  );
  state = await snapshot();
  assert.equal(
    state.rooms[1].suggestions[0].status,
    "draft",
    "Using a suggestion must not dispatch work",
  );
  await checkpoint(
    "Chat selection, persisted suggestion editing, attribution, and draft-only use",
  );

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
  state = await snapshot();
  assert.equal(state.rooms[1].messages.length, 1);
  assert.equal(state.rooms[1].tabs[0].title, "Codex 1");
  await page.getByRole("tab", { name: /Codex 1/ }).waitFor();
  await checkpoint(
    "Reload reconciles persisted room, repository, chat, suggestions, and tabs",
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
      .getByRole("textbox", { name: "Message", exact: true })
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
    "The desktop must not alter the selected repository",
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
  await programs?.close();
}
