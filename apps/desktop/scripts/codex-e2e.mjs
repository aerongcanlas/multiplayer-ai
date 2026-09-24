// Codex tab end to end. By default it uses the Codex fixture and a loopback download server to
// cover in-app ChatGPT sign-in. With `--live --repository <path>` it downloads the pinned Codex,
// uses the machine's real Codex sign-in, and runs one read-only plan-mode turn for the release check.
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import assert from "node:assert/strict";
import { startProgramServer } from "./programs-fixture.mjs";

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
    {
      windowsHide: true,
      stdio: "pipe",
    },
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
// A live run must leave the chosen repository exactly as it was.
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
const programs = live
  ? undefined
  : await startProgramServer(join(output, "manifest.json"));
const environment = {
  ...process.env,
  MP_E2E: "1",
  MP_TEST_USER_DATA: join(output, "user-data"),
  ...(live
    ? {}
    : {
        MP_TEST_CODEX_FIXTURE: join(appDirectory, "scripts/codex-fixture.mjs"),
        MP_TEST_HARNESS_MANIFEST: join(output, "manifest.json"),
        MP_FIXTURE_STATE: join(output, "codex-threads.json"),
      }),
};
// The fixture starts signed out so the in-app sign-in runs.
delete environment.MP_FIXTURE_SIGNED_IN;
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;

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
async function until(check, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
const codex = async () =>
  (await snapshot()).harnesses.find((item) => item.id === "codex");
const tab = async () => (await snapshot()).rooms[0].tabs[0];

try {
  application = await electron.launch({
    executablePath: require("electron"),
    args: [appDirectory],
    cwd: appDirectory,
    env: environment,
    timeout: 30_000,
  });
  await application.evaluate(({ shell }) => {
    globalThis.opened = [];
    shell.openExternal = async (url) => {
      globalThis.opened.push(url);
    };
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("heading", { name: "My workspace", exact: true })
    .waitFor();
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
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await until(
    async () => ["ready"].includes((await codex()).program.state),
    "the managed Codex download",
    live ? 20 * 60_000 : 30_000,
  );
  checkpoint(
    `Managed Codex ${(await codex()).program.version} downloaded and verified`,
  );

  if (!live) {
    await until(
      async () => (await codex()).auth.state === "signed_out",
      "the signed-out state",
    );
    await page
      .getByRole("region", { name: "AI tabs" })
      .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
      .click();
    await until(
      async () => (await codex()).auth.state === "signed_in",
      "the ChatGPT sign-in",
    );
    assert.deepEqual(await application.evaluate(() => globalThis.opened), [
      "https://auth.openai.com/authorize?state=fixture",
    ]);
    checkpoint("In-app ChatGPT sign-in opens only the allowlisted login page");
  }

  await until(
    async () => (await tab()).status === "idle",
    "a ready Codex tab",
    90_000,
  );
  const models = (await codex()).models;
  assert.ok(models.length > 0);
  checkpoint(`Codex lists ${models.length} models for this account`);

  // A read-only plan-mode turn: the access mode keeps Codex in its read-only sandbox.
  await page.getByRole("checkbox", { name: "Plan mode" }).check();
  await until(async () => (await tab()).loadout.planMode, "plan mode");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(
      live
        ? "Plan only: in one sentence, what is this repository for? Do not edit files or run commands that change anything."
        : "Plan the change",
    );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(
    async () => !["running", "awaiting_host"].includes((await tab()).status),
    "the plan-mode turn",
    live ? 10 * 60_000 : 30_000,
  );
  assert.equal((await tab()).status, "idle");
  await page.getByRole("region", { name: "Plan" }).last().waitFor();
  checkpoint("A plan-mode turn completes with a plan");

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
  await programs?.close();
}
