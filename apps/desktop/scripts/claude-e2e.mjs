// Live Claude Code release check (manual): `node scripts/claude-e2e.mjs --repository <path>`.
// Uses the managed Claude Code download and its own app-owned login: the run starts signed out,
// you finish one real sign-in on Anthropic's page in your browser, and the run signs out at the end
// so no keychain item is left. A throwaway folder stands in for the host's Claude Code folder, so
// your real ~/.claude and its login are never touched. It covers AE1 (a host logout leaves the tab
// signed in), models, a project skill that asks a question, continuing from native plan mode, two
// tabs at once, and resuming the session after an app restart. Writes are declined, so the
// repository must stay unchanged apart from the skill this script adds under an ignored path.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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
// `--user-data <path>` reuses an earlier run's profile, which may already be signed in.
const reuse = process.argv.indexOf("--user-data");
const userData =
  reuse < 0 ? join(output, "user-data") : resolve(process.argv[reuse + 1]);
// The stand-in host folder: a skill to carry over, and its own (empty) login.
const hostClaude = join(output, "host-claude");
await mkdir(join(hostClaude, "skills", "host-check"), { recursive: true });
await writeFile(
  join(hostClaude, "skills", "host-check", "SKILL.md"),
  "---\nname: host-check\ndescription: Reply with the word carried.\n---\nReply with the single word: carried.\n",
);

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
    { MP_TEST_USER_DATA: userData, CLAUDE_CONFIG_DIR: hostClaude },
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
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
/** The managed Claude Code the app downloaded for this run. */
async function managedClaude() {
  const root = join(userData, "harnesses", "claude");
  const [version] = await readdir(root);
  return join(root, version, "claude");
}
const claudeCli = async (args, configDir) =>
  execFileSync(await managedClaude(), args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: configDir,
    },
  });
/** Re-reads sign-in in Settings, as the app itself sees it. */
async function refreshClaude() {
  await run.page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = run.page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Claude Code" }).click();
  await dialog
    .getByRole("button", { name: "Refresh Claude Code", exact: true })
    .click();
  await run.page.keyboard.press("Escape");
  await wait(3_000);
}

await run.execute(async () => {
  await launch();
  // A reused profile already has its repository and Claude Code tab.
  if (!(await snapshot()).rooms[0]?.workspace)
    await selectRepository(repository);
  if (!(await snapshot()).rooms[0]?.tabs.length) {
    await panel().getByRole("button", { name: "New tab", exact: true }).click();
    await run.page
      .getByRole("menuitem", { name: "Claude Code", exact: true })
      .click();
  }
  await until(
    async () => (await claude()).program.state === "ready",
    "the managed download",
    20 * 60_000,
  );
  await until(
    async () =>
      ["signed_out", "signed_in"].includes((await claude()).auth.state),
    "the app's own Claude Code home to report its sign-in",
  );
  if ((await claude()).auth.state === "signed_out") {
    console.log(
      "ACTION: Claude Code opens Anthropic's sign-in page in your browser. Finish signing in there.",
    );
    await panel().getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await until(
    async () => (await tab()).status === "idle",
    "a signed-in Claude Code tab",
    10 * 60_000,
  );
  const harness = await claude();
  assert.equal(harness.auth.state, "signed_in");
  assert.ok(harness.auth.account);
  assert.ok(harness.models.length > 0);
  await checkpoint(
    `Managed Claude Code ${harness.program.version} signed in through Anthropic's page (${harness.auth.plan ?? "subscription"}), ${harness.models.length} models`,
  );

  // AE1: Claude Code in a terminal logging out of the host folder leaves the tab signed in.
  await claudeCli(["auth", "logout"], hostClaude);
  await refreshClaude();
  assert.equal((await claude()).auth.state, "signed_in");
  assert.equal((await claude()).auth.account, harness.auth.account);
  await send("/host-check");
  await settled();
  await panel()
    .locator(".turn-assistant")
    .filter({ hasText: /carried/i })
    .last()
    .waitFor();
  await checkpoint(
    "A logout in the host's Claude Code folder leaves the tab signed in, and a host skill carries over (AE1, AE3)",
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

  await panel().getByRole("button", { name: "Add", exact: true }).click();
  await panel().getByRole("menuitemcheckbox", { name: "Plan mode" }).click();
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

  // Two tabs run at once without either signing out.
  await panel().getByRole("button", { name: "New tab", exact: true }).click();
  await run.page
    .getByRole("menuitem", { name: "Claude Code", exact: true })
    .click();
  const tabs = async () => (await snapshot()).rooms[0].tabs;
  await until(
    async () => (await tabs())[1]?.status === "idle",
    "a second Claude Code tab",
  );
  await send("Reply with the single word: second.");
  await panel()
    .getByRole("tab", { name: new RegExp((await tabs())[0].title) })
    .click();
  await send("Reply with the single word: first.");
  await until(
    async () =>
      (await tabs()).every(
        (item) => !["running", "awaiting_host"].includes(item.status),
      ),
    "both tabs to finish",
  );
  assert.ok((await tabs()).every((item) => item.status === "idle"));
  assert.equal((await claude()).auth.state, "signed_in");
  await checkpoint("Two Claude Code tabs run at once and both stay signed in");

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

  // Sign out runs Claude Code's own logout in the app's home, so no keychain item is left.
  await run.page.getByRole("button", { name: "Settings", exact: true }).click();
  await run.page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("tab", { name: "Claude Code" })
    .click();
  await run.page
    .getByRole("region", { name: "Harness settings" })
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await until(
    async () => (await claude()).auth.state === "signed_out",
    "Claude Code to sign out",
  );
  await run.page.keyboard.press("Escape");
  // The app re-runs Claude Code's own `auth status` against its folder.
  await refreshClaude();
  assert.equal((await claude()).auth.state, "signed_out");
  await checkpoint(
    "Sign out leaves the app's Claude Code home signed out with no stored login",
  );
});
