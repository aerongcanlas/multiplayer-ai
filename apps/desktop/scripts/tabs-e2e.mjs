// Chat tabs end to end with harness fixtures: managed downloads from a loopback server, Codex and
// Claude Code tabs, approvals, questions, plan mode, Stop, close, suggestions, restart resume,
// crash recovery, and Mission Control's lead context, sub-agent cards, and drill-in. Nothing leaves
// the machine.
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { startProgramServer } from "./programs-fixture.mjs";
import {
  appDirectory,
  createRun,
  crashApplication,
  fixtureRepository,
  outputDirectory,
  stubOpenDialog,
  testEnvironment,
} from "./e2e-support.mjs";

const output = await outputDirectory("tabs-");
const repository = join(output, "repository");
const claudeState = join(output, "claude-fixture.json");
const codexLog = join(output, "codex-fixture.jsonl");
const git = await fixtureRepository(repository, { readme: "Tabs fixture\n" });
// Claude Code starts signed out to show guidance; the test signs it in later.
await writeFile(claudeState, JSON.stringify({ signedIn: false, sessions: {} }));
const programs = await startProgramServer(join(output, "manifest.json"));
programs.corrupt("claude");

const run = createRun({
  output,
  environment: testEnvironment({
    MP_TEST_USER_DATA: join(output, "user-data"),
    MP_TEST_CODEX_FIXTURE: join(appDirectory, "scripts/codex-fixture.mjs"),
    MP_TEST_CLAUDE_FIXTURE: claudeState,
    MP_TEST_HARNESS_MANIFEST: join(output, "manifest.json"),
    MP_FIXTURE_SIGNED_IN: "1",
    MP_FIXTURE_STATE: join(output, "codex-threads.json"),
    MP_FIXTURE_LOG: codexLog,
  }),
  // Record, rather than perform, anything that would leave the app window.
  prepare: (application) =>
    application.evaluate(({ shell }) => {
      globalThis.external = [];
      shell.openExternal = async (url) => {
        globalThis.external.push(["openExternal", url]);
      };
      shell.openPath = async (path) => {
        globalThis.external.push(["openPath", path]);
        return "";
      };
    }),
});
const { launch, checkpoint, snapshot, until, send, selectRepository } = run;

const room = async () => (await snapshot()).rooms[0];
const tabNamed = async (title) =>
  (await room()).tabs.find((tab) => tab.title === title);
const harness = async (id) =>
  (await snapshot()).harnesses.find((item) => item.id === id);
const tabsPanel = () => run.page.getByRole("region", { name: "AI tabs" });
const settings = () =>
  run.page.getByRole("region", { name: "Harness settings" });
const harnessRow = (label) =>
  settings().locator(".harness-row").filter({ hasText: label });
const mission = () => run.page.getByRole("region", { name: "Mission Control" });
const leadContext = () =>
  mission().getByRole("region", { name: "Lead context" });
const agentTasks = () => mission().getByRole("region", { name: "Agent tasks" });
const agentCard = (description) =>
  agentTasks().locator(".agent-card").filter({ hasText: description });
const tabChip = (title) =>
  tabsPanel().getByRole("tab", { name: new RegExp(title) });

async function selectTab(title) {
  await tabsPanel()
    .getByRole("tab", { name: new RegExp(title) })
    .click();
}
const settled = (title) =>
  run.settled(() => tabNamed(title), `${title} to finish its turn`);
async function codexRequests(method) {
  return (await readFile(codexLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "request" && entry.method === method);
}

await run.execute(
  async () => {
    await launch();
    await selectRepository(repository);

    // The first Codex tab downloads, verifies, and becomes ready.
    await tabsPanel()
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await run.page
      .getByRole("menuitem", { name: "Codex", exact: true })
      .click();
    await until(
      async () => (await tabNamed("Codex 1"))?.status === "idle",
      "the Codex tab to become ready",
    );
    assert.equal(programs.requests("codex"), 1);
    assert.equal((await harness("codex")).program.state, "ready");
    assert.equal((await tabNamed("Codex 1")).loadout.model, "fixture-codex");
    // Only the efforts the model reports are offered.
    await tabsPanel()
      .getByRole("button", { name: "Model", exact: true })
      .click();
    await tabsPanel()
      .getByRole("menuitem", { name: "Effort", exact: true })
      .click();
    assert.deepEqual(
      await tabsPanel()
        .getByRole("group", { name: "Effort levels" })
        .getByRole("menuitemradio")
        .allTextContents(),
      ["medium", "low"],
    );
    await run.page.keyboard.press("Escape");
    await checkpoint(
      "A first Codex tab downloads, verifies, and becomes ready",
    );

    // An approval card pauses the turn until the host approves.
    await send("FIXTURE_APPROVAL inspect the checkout");
    const approval = tabsPanel().getByRole("region", {
      name: "Agent approval",
    });
    await approval.getByText("Run command: git status --short").waitFor();
    await until(
      async () => (await tabNamed("Codex 1")).status === "awaiting_host",
      "the approval to pause the turn",
    );
    const agentDraft = tabsPanel().getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    const agentSend = tabsPanel().locator('button[type="submit"]');
    assert.equal(
      await agentDraft.isEnabled(),
      true,
      "Drafting stays available during a turn",
    );
    assert.equal(
      await agentDraft.evaluate((input) => input === document.activeElement),
      true,
      "Clicking Send keeps focus in the agent composer",
    );
    await run.page.keyboard.type("Follow up after approval");
    await agentDraft.press("Shift+Enter");
    await agentDraft.pressSequentially("Keep this second line.");
    const followUp = await agentDraft.inputValue();
    assert.equal(followUp, "Follow up after approval\nKeep this second line.");
    assert.equal(await agentSend.isDisabled(), true);
    const startedTurns = (await codexRequests("turn/start")).length;
    await agentDraft.press("Enter");
    assert.equal(await agentDraft.inputValue(), followUp);
    assert.equal((await codexRequests("turn/start")).length, startedTurns);
    await run.page.screenshot({ path: join(output, "01-approval.png") });
    await approval
      .getByRole("button", { name: "Approve once", exact: true })
      .click();
    await settled("Codex 1");
    await tabsPanel()
      .getByText("git status --short (exit 0)")
      .first()
      .waitFor();
    await tabsPanel()
      .getByText(/^Turn completed\./)
      .first()
      .waitFor();
    await until(
      () => agentSend.isEnabled(),
      "Send to enable after turn completion",
    );
    assert.equal(await agentDraft.inputValue(), followUp);
    assert.equal((await codexRequests("turn/start")).length, startedTurns);
    await agentDraft.focus();
    await run.page.keyboard.press("Enter");
    await until(
      async () => (await agentDraft.inputValue()) === "",
      "the follow-up to be accepted",
    );
    await settled("Codex 1");
    assert.equal((await codexRequests("turn/start")).length, startedTurns + 1);
    assert.equal(
      await agentDraft.evaluate((input) => input === document.activeElement),
      true,
      "Sending with Enter keeps focus in the agent composer",
    );
    await run.page.keyboard.type("Keep typing without another click");
    assert.equal(
      await agentDraft.inputValue(),
      "Keep typing without another click",
    );
    await checkpoint(
      "Click and Enter preserve composer focus; drafting works during turns while sending waits",
    );

    // Stop while an approval is pending ends the turn stopped.
    await send("FIXTURE_APPROVAL again");
    await tabsPanel()
      .getByRole("button", { name: "Approve once", exact: true })
      .waitFor();
    await tabsPanel()
      .getByRole("button", { name: "Stop", exact: true })
      .click();
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
    await tabsPanel().getByRole("button", { name: "Add", exact: true }).click();
    await tabsPanel()
      .getByRole("menuitemcheckbox", { name: "Plan mode" })
      .click();
    await until(
      async () => (await tabNamed("Codex 1")).loadout.planMode,
      "plan mode",
    );
    await send("Plan the change");
    await settled("Codex 1");
    const plan = tabsPanel().getByRole("region", { name: "Plan" }).last();
    await plan.getByRole("button", { name: "Continue into execution" }).click();
    await until(
      async () => !(await tabNamed("Codex 1")).loadout.planMode,
      "the continuation to leave plan mode",
    );
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

    // Use a missing path: on Windows, the fixture replaces the executable handshake.
    const bad = join(output, "missing-program.exe");
    await stubOpenDialog(run.application, bad);
    await harnessRow("Codex")
      .locator("summary", { hasText: "Program" })
      .click();
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
    await run.page
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

    // Signed-out Claude Code shows guidance, no sign-in button, and the one-time notice.
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
    await run.page.screenshot({
      path: join(output, "03-claude-signed-out.png"),
    });
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

    // A skill's question appears as a card and the answer continues the turn.
    await send("/review FIXTURE_ASK");
    const question = tabsPanel().getByRole("form", {
      name: "Harness question",
    });
    await question.getByText("Which approach should the skill take?").waitFor();
    await question.getByRole("radio", { name: /Thorough/ }).check();
    await run.page.screenshot({ path: join(output, "02-question.png") });
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
    await tabsPanel().getByRole("button", { name: "Add", exact: true }).click();
    await tabsPanel()
      .getByRole("menuitemcheckbox", { name: "Plan mode" })
      .click();
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

    // A tab whose harness kept no to-do list shows its state and a no-plan note.
    await leadContext()
      .getByText(/No plan in this tab/)
      .waitFor();
    await leadContext().getByText("Claude Code", { exact: true }).waitFor();
    await leadContext().getByText("Act", { exact: true }).waitFor();
    await agentTasks()
      .getByText(/No sub-agents in this tab yet/)
      .waitFor();
    await checkpoint("Lead context shows the tab's state and a no-plan note");

    // Sub-agents get cards under the turn; a mid-turn sub-agent approval names its
    // sub-agent and leaves the turn running; a background card outlives the turn.
    await send("FIXTURE_AGENTS FIXTURE_BACKGROUND");
    const inspectApproval = tabsPanel().getByRole("region", {
      name: "Approval for sub-agent Inspect the checkout",
    });
    await inspectApproval
      .getByText("Sub-agent · Inspect the checkout")
      .waitFor();
    assert.equal((await tabNamed("Claude Code 1")).status, "running");
    await inspectApproval
      .getByRole("button", { name: "Approve once", exact: true })
      .click();
    await settled("Claude Code 1");
    await agentCard("Inspect the checkout").getByText("Completed").waitFor();
    await agentCard("Inspect the checkout")
      .getByText("Found README.md.")
      .waitFor();
    await agentCard("Read the README").getByText("Completed").waitFor();
    await agentCard("Run the tests").getByText("Running").waitFor();
    await tabChip("Claude Code 1").getByText("1 running").waitFor();
    assert.equal((await tabNamed("Claude Code 1")).runningAgents, 1);
    await leadContext()
      .getByRole("list", { name: "Lead plan" })
      .getByText("Test")
      .waitFor();
    await run.page.screenshot({ path: join(output, "04-mission-control.png") });
    await checkpoint(
      "Sub-agent cards appear under the turn and a background card outlives it",
    );

    // A card opens its sub-agent's own transcript, read-only, and back returns to the lead.
    await agentCard("Inspect the checkout").click();
    await tabsPanel()
      .getByRole("heading", { name: "Inspect the checkout" })
      .waitFor();
    await tabsPanel().getByText("Looking around.").waitFor();
    assert.equal(await tabsPanel().getByText("Inspection done.").count(), 0);
    assert.equal(
      await tabsPanel().getByRole("textbox", { name: "Message" }).count(),
      0,
    );
    await run.page.screenshot({ path: join(output, "05-drill-in.png") });
    await tabsPanel()
      .getByRole("button", { name: "Back to Claude Code 1" })
      .click();
    await tabsPanel().getByText("Inspection done.").waitFor();
    assert.equal(await tabsPanel().getByText("Looking around.").count(), 0);
    await checkpoint(
      "A card opens its sub-agent's transcript and back returns",
    );

    // The background sub-agent asks after the turn; the tab stays idle and usable.
    const backgroundApproval = tabsPanel().getByRole("region", {
      name: "Approval for sub-agent Run the tests",
    });
    await backgroundApproval.getByText("Run command: pnpm test").waitFor();
    await tabChip("Claude Code 1")
      .getByRole("img", { name: "A sub-agent needs you" })
      .waitFor();
    assert.equal((await tabNamed("Claude Code 1")).status, "idle");
    await send("Hello while it waits");
    await settled("Claude Code 1");
    await backgroundApproval
      .getByRole("button", { name: "Approve once", exact: true })
      .click();
    await until(
      async () => !(await tabNamed("Claude Code 1")).agentRequests,
      "the needs-you mark to clear",
    );
    // The finished sub-agent wakes the lead in a turn of its own.
    await tabsPanel()
      .getByText("The background agent reports: All tests passed.")
      .waitFor();
    await settled("Claude Code 1");
    await agentCard("Run the tests").getByText("All tests passed.").waitFor();
    assert.equal((await tabNamed("Claude Code 1")).runningAgents, undefined);
    assert.equal(
      await tabChip("Claude Code 1")
        .getByText(/running/)
        .count(),
      0,
    );
    await checkpoint(
      "A background approval never blocks the tab and its reply lands as a new turn",
    );

    // Stop on an idle tab stops its background sub-agent.
    await tabsPanel()
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await run.page
      .getByRole("menuitem", { name: "Claude Code", exact: true })
      .click();
    await until(
      async () => (await tabNamed("Claude Code 2"))?.status === "idle",
      "Claude Code 2",
    );
    await selectTab("Claude Code 2");
    await send("FIXTURE_BACKGROUND");
    await settled("Claude Code 2");
    await tabsPanel()
      .getByRole("region", { name: "Approval for sub-agent Run the tests" })
      .waitFor();
    await tabsPanel()
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await agentCard("Run the tests")
      .getByText("Stopped", { exact: true })
      .waitFor();
    await agentCard("Run the tests")
      .getByText("Stopped before finishing")
      .waitFor();
    assert.equal((await tabNamed("Claude Code 2")).runningAgents, undefined);
    assert.equal((await tabNamed("Claude Code 2")).agentRequests, undefined);
    await checkpoint("Stop on an idle tab stops its background sub-agent");

    // Two tabs in one room run turns concurrently.
    await selectTab("Claude Code 1");
    await send("FIXTURE_SLOW");
    await selectTab("Codex 1");
    await send("FIXTURE_SLOW");
    await until(async () => {
      const tabs = (await room()).tabs.filter((tab) =>
        ["Codex 1", "Claude Code 1"].includes(tab.title),
      );
      return tabs.every((tab) => tab.status === "running");
    }, "both tabs to run");
    assert.equal(await agentDraft.isEnabled(), true);
    await agentDraft.fill("Keep this draft after stopping");
    assert.equal(await agentSend.isDisabled(), true);
    await agentDraft.press("Enter");
    assert.equal(
      await agentDraft.inputValue(),
      "Keep this draft after stopping",
    );
    await tabsPanel()
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await settled("Codex 1");
    await until(() => agentSend.isEnabled(), "Send to enable after Stop");
    assert.equal(
      await agentDraft.inputValue(),
      "Keep this draft after stopping",
    );
    await agentDraft.fill("");
    await selectTab("Claude Code 1");
    await tabsPanel()
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await settled("Codex 1");
    await settled("Claude Code 1");
    await checkpoint("Two tabs run turns concurrently and stop independently");

    // Closing a running tab asks for confirmation.
    await tabsPanel()
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await run.page
      .getByRole("menuitem", { name: "Codex", exact: true })
      .click();
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
    const confirm = run.page.getByRole("alertdialog", {
      name: "Close running tab",
    });
    await confirm.getByText(/Stop it and close the tab\?/).waitFor();
    assert.ok(await tabNamed("Codex 2"));
    await confirm
      .getByRole("button", { name: "Stop and close", exact: true })
      .click();
    await until(async () => !(await tabNamed("Codex 2")), "Codex 2 to close");
    await checkpoint(
      "Closing a running tab asks for confirmation, then stops and closes it",
    );

    // A room suggestion fills the active tab, and the sent turn shows its source.
    await selectTab("Codex 1");
    const chatDraft = run.page.getByRole("textbox", {
      name: "Group chat message",
      exact: true,
    });
    await chatDraft.fill("Keep the README short.");
    await run.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await until(
      async () => (await chatDraft.inputValue()) === "",
      "the local chat message to be accepted",
    );
    assert.equal(
      await chatDraft.evaluate((input) => input === document.activeElement),
      true,
    );
    await run.page.keyboard.type("Keep typing in local group chat");
    assert.equal(
      await chatDraft.inputValue(),
      "Keep typing in local group chat",
    );
    await run.page
      .getByRole("checkbox", { name: /Select message: Keep the README/ })
      .click();
    await run.page
      .getByRole("button", { name: "Suggest prompts", exact: true })
      .click();
    await run.page
      .getByRole("button", { name: "Use prompt", exact: true })
      .click();
    const composer = tabsPanel().getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    assert.equal(
      await composer.inputValue(),
      "Add a dark mode toggle, persist the selected theme, and verify it survives a restart.",
    );
    assert.equal((await room()).suggestions[0].status, "draft");
    await tabsPanel()
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await settled("Codex 1");
    await tabsPanel()
      .getByText(/From a room suggestion · 1 source message/)
      .waitFor();
    assert.equal((await room()).suggestions[0].status, "submitted");
    await checkpoint(
      "A room suggestion fills the active tab and the turn shows its source",
    );

    // After a restart, a follow-up continues the same Codex thread.
    const threadId = (await tabNamed("Codex 1")).sessionId;
    assert.ok(threadId);
    await run.application.close();
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
    await checkpoint(
      "After a restart a follow-up continues the fixture session",
    );

    // A background sub-agent is still running when the app dies.
    await tabsPanel()
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await run.page
      .getByRole("menuitem", { name: "Claude Code", exact: true })
      .click();
    await until(
      async () => (await tabNamed("Claude Code 3"))?.status === "idle",
      "Claude Code 3",
    );
    await selectTab("Claude Code 3");
    await send("FIXTURE_BACKGROUND");
    await settled("Claude Code 3");
    await agentCard("Run the tests").getByText("Running").waitFor();
    await selectTab("Codex 1");

    // Killing the app mid-turn leaves the turn interrupted with nothing pending.
    await send("FIXTURE_APPROVAL before the crash");
    await tabsPanel()
      .getByRole("button", { name: "Approve once", exact: true })
      .waitFor();
    await crashApplication(run.application);
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

    // The sub-agent that was running reads interrupted, not running.
    await selectTab("Claude Code 3");
    await agentCard("Run the tests")
      .getByText("Interrupted", { exact: true })
      .waitFor();
    await agentCard("Run the tests")
      .getByText("Interrupted before finishing")
      .waitFor();
    assert.equal((await tabNamed("Claude Code 3")).status, "idle");
    assert.equal(
      await tabsPanel().getByRole("button", { name: "Approve once" }).count(),
      0,
    );
    await checkpoint(
      "A sub-agent running at a crash reads interrupted after relaunch",
    );

    // Nothing left the app: no browser, no terminal, no remote requests.
    const external = await run.application.evaluate(() => globalThis.external);
    assert.deepEqual(external, []);
    assert.deepEqual(
      run.network.filter(
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
    assert.deepEqual(run.errors, [], "No renderer errors");
    await checkpoint(
      "No external windows, terminals, remote requests, or renderer errors",
    );
  },
  { cleanup: () => programs.close() },
);
