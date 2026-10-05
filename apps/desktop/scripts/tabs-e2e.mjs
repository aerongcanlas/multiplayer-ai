// Chat tabs end to end with harness fixtures: managed downloads from a loopback server, Codex,
// Claude Code, and OpenCode tabs, approvals, questions, plan mode, Stop, close, suggestions, restart resume,
// crash recovery, Mission Control's lead context, sub-agent cards, and drill-in, and app-owned
// harness logins over a fake host setup. Nothing leaves the machine.
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
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
const codexState = join(output, "codex-threads.json");
// A fake host setup: Claude Code and Codex folders the app links from, never writes to.
const hostClaude = join(output, "host-claude");
const hostCodex = join(output, "host-codex");
const SECRETS = [
  "sk-ant-oat01-e2e-host-token",
  "e2e-mcp-secret-env",
  "e2e-mcp-secret-header",
  "e2e-marker-credential",
];
const opencodeLog = join(output, "opencode-fixture.jsonl");
// OpenCode sees one local Ollama model in place of probing the real servers.
const opencodeDiscovery = {
  servers: [
    {
      id: "ollama",
      label: "Ollama",
      running: true,
      models: [
        { id: "qwen3-coder:30b", name: "qwen3-coder:30b", context: 65536 },
        {
          id: "gemma3:12b",
          name: "gemma3:12b",
          warning:
            "Served context is unknown; agentic use needs at least 32k. Start Ollama with a larger OLLAMA_CONTEXT_LENGTH (https://docs.ollama.com/context-length).",
        },
      ],
    },
    { id: "lmstudio", label: "LM Studio", running: false, models: [] },
  ],
  providers: [
    {
      id: "ollama",
      name: "Ollama",
      baseURL: "http://127.0.0.1:11434/v1",
      models: [
        { id: "qwen3-coder:30b", name: "qwen3-coder:30b", context: 65536 },
        { id: "gemma3:12b", name: "gemma3:12b" },
      ],
    },
  ],
};
const git = await fixtureRepository(repository, { readme: "Tabs fixture\n" });
await mkdir(join(hostClaude, "skills", "host-skill"), { recursive: true });
await writeFile(
  join(hostClaude, "skills", "host-skill", "SKILL.md"),
  "---\nname: host-skill\ndescription: A host skill\n---\nBody\n",
);
await writeFile(join(hostClaude, "settings.json"), '{"model":"sonnet"}\n');
await mkdir(join(hostClaude, "projects", "-host-repo", "memory"), {
  recursive: true,
});
await writeFile(
  join(hostClaude, "projects", "-host-repo", "memory", "MEMORY.md"),
  "- host memory\n",
);
await writeFile(join(hostClaude, ".credentials.json"), "e2e-marker-credential");
await writeFile(
  join(hostClaude, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      "e2e-server": {
        type: "stdio",
        command: "e2e-mcp",
        env: { API_TOKEN: "e2e-mcp-secret-env" },
      },
    },
    projects: {
      [repository]: {
        mcpServers: {
          "e2e-remote": {
            type: "http",
            url: "https://mcp.example.invalid",
            headers: { Authorization: "Bearer e2e-mcp-secret-header" },
          },
        },
      },
    },
  }),
);
await mkdir(join(hostCodex, "skills"), { recursive: true });
await writeFile(join(hostCodex, "config.toml"), 'model = "fixture-codex"\n');
await writeFile(join(hostCodex, "AGENTS.md"), "Host instructions\n");
/** Every host file with its content hash, without following links. */
async function tree(root, base = root) {
  const files = {};
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isDirectory()) Object.assign(files, await tree(path, base));
    else
      files[path.slice(base.length)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return files;
}
const hostBefore = {
  claude: await tree(hostClaude),
  codex: await tree(hostCodex),
};
// Claude Code starts signed out; the test signs it in from the tab later.
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
    MP_FIXTURE_STATE: codexState,
    MP_FIXTURE_LOG: codexLog,
    MP_TEST_OPENCODE_FIXTURE: join(
      appDirectory,
      "scripts/opencode-fixture.mjs",
    ),
    MP_TEST_OPENCODE_DISCOVERY: JSON.stringify(opencodeDiscovery),
    MP_OPENCODE_FIXTURE_LOG: opencodeLog,
    // Stand-ins for the host's own harness folders: Claude Code and Codex tabs run in app homes
    // and link setup from these, while OpenCode uses its data folder directly.
    XDG_DATA_HOME: join(output, "xdg-data"),
    CLAUDE_CONFIG_DIR: hostClaude,
    CODEX_HOME: hostCodex,
    // A host shell's Claude Code token never reaches a harness launch (R2).
    CLAUDE_CODE_OAUTH_TOKEN: SECRETS[0],
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
/** Opens Settings on one harness's page; Escape closes it again. */
async function openSettings(label) {
  await run.page.getByRole("button", { name: "Settings", exact: true }).click();
  await run.page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("tab", { name: label })
    .click();
}
const closeSettings = () => run.page.keyboard.press("Escape");
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
async function opencodeRequests(method) {
  return (await readFile(opencodeLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === method);
}
const opencodeTab = async () =>
  (await room()).tabs.find((tab) => tab.loadout.harness === "opencode");
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
    const agentSend = tabsPanel().locator(".composer-footer > button");
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
    assert.equal(await agentSend.isEnabled(), true);
    assert.equal(await agentSend.getAttribute("aria-label"), "Stop");
    assert.equal(await agentSend.getAttribute("type"), "button");
    assert.equal(
      await tabsPanel()
        .locator("header")
        .getByRole("button", { name: "Stop", exact: true })
        .count(),
      0,
      "Stop is only available in the composer",
    );
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
    assert.equal(await agentSend.getAttribute("aria-label"), "Send");
    assert.equal(await agentSend.getAttribute("type"), "submit");
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
    await openSettings("Codex");
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
    await closeSettings();
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

    // Signed-out Claude Code offers its own in-app sign-in and the one-time notice.
    await until(
      async () => (await harness("claude")).auth.state === "signed_out",
      "Claude Code sign-in state",
    );
    const claudeSignIn = tabsPanel().getByRole("button", {
      name: "Sign in",
      exact: true,
    });
    await claudeSignIn.waitFor();
    assert.doesNotMatch(
      (await harness("claude")).auth.message ?? "",
      /\/login/,
    );
    const notice = tabsPanel().getByRole("note", {
      name: "Claude Code sign-in notice",
    });
    await notice.getByText(/never sees your password or token/).waitFor();
    await run.page.screenshot({
      path: join(output, "03-claude-signed-out.png"),
    });
    await notice.getByRole("button", { name: "Got it", exact: true }).click();
    await until(
      async () => !(await harness("claude")).noticePending,
      "notice acknowledgement",
    );
    assert.equal(await tabsPanel().getByRole("note").count(), 0);
    // The fixture's `claude auth login` succeeds in the app's own Claude home.
    await claudeSignIn.click();
    await until(
      async () => (await tabNamed("Claude Code 1"))?.status === "idle",
      "the Claude Code tab to become ready",
    );
    assert.equal(
      (await harness("claude")).auth.account,
      "fixture@example.invalid",
    );
    await checkpoint(
      "Signed-out Claude Code signs in from the tab and shows the one-time notice once",
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

    // The background sub-agent asks after the turn; drafting stays available,
    // and the composer keeps its Stop action until the sub-agent finishes.
    const backgroundApproval = tabsPanel().getByRole("region", {
      name: "Approval for sub-agent Run the tests",
    });
    await backgroundApproval.getByText("Run command: pnpm test").waitFor();
    await tabChip("Claude Code 1")
      .getByRole("img", { name: "A sub-agent needs you" })
      .waitFor();
    assert.equal((await tabNamed("Claude Code 1")).status, "idle");
    await agentDraft.fill("Hello while it waits");
    assert.equal(await agentSend.getAttribute("aria-label"), "Stop");
    await agentDraft.press("Enter");
    assert.equal(await agentDraft.inputValue(), "Hello while it waits");
    assert.equal((await tabNamed("Claude Code 1")).status, "idle");
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
    assert.equal(await agentDraft.inputValue(), "Hello while it waits");
    await send("Hello while it waits");
    await settled("Claude Code 1");
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
    assert.equal(await agentSend.isEnabled(), true);
    assert.equal(await agentSend.getAttribute("aria-label"), "Stop");
    assert.equal(await agentSend.getAttribute("type"), "button");
    await agentDraft.press("Enter");
    assert.equal(
      await agentDraft.inputValue(),
      "Keep this draft after stopping",
    );
    await tabsPanel()
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await settled("Codex 1");
    await until(
      async () =>
        (await agentSend.getAttribute("aria-label")) === "Send" &&
        (await agentSend.isEnabled()),
      "Send to enable after Stop",
    );
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

    // Cmd/Ctrl+T opens a tab on the active harness and Cmd/Ctrl+W closes it.
    const openCount = async () => (await room()).tabs.length;
    const before = await openCount();
    await run.page.keyboard.press("Control+t");
    await until(async () => (await openCount()) === before + 1, "a new tab");
    const created = (await room()).tabs.at(-1);
    await until(
      async () => (await tabNamed(created.title))?.status === "idle",
      "the new tab",
    );
    await run.page.keyboard.press("Control+w");
    await until(async () => (await openCount()) === before, "the tab to close");
    // Right-click offers actions on an open chat, not only a closed one.
    const chats = run.page.getByRole("list", { name: /^Chats in / });
    await chats
      .getByRole("button", { name: /Codex 1/ })
      .click({ button: "right" });
    const chatMenu = run.page.getByRole("menu", { name: "Codex 1 actions" });
    await chatMenu.getByRole("menuitem", { name: "Close chat" }).waitFor();
    await chatMenu.getByRole("menuitem", { name: "Delete chat…" }).waitFor();
    await run.page.keyboard.press("Escape");
    await chatMenu.waitFor({ state: "hidden" });
    await checkpoint(
      "Tab shortcuts open and close tabs, and open chats have a context menu",
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

    // An OpenCode tab downloads its managed program and runs on the local model it found.
    await tabsPanel()
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await run.page
      .getByRole("menuitem", { name: "OpenCode", exact: true })
      .click();
    await until(
      async () => (await opencodeTab())?.status === "idle",
      "the OpenCode tab to become ready",
    );
    const opencodeTitle = (await opencodeTab()).title;
    assert.equal(programs.requests("opencode"), 1);
    assert.equal((await harness("opencode")).auth.account, "Local models");
    assert.equal((await opencodeTab()).loadout.model, "ollama/qwen3-coder:30b");
    await selectTab(opencodeTitle);
    await send("Say hello");
    await settled(opencodeTitle);
    await tabsPanel().getByText("Hello world.").last().waitFor();
    await checkpoint("An OpenCode tab completes a streamed turn");

    // Ask mode turns OpenCode's permission request into an approval card.
    await send("FIXTURE_PERMISSION accept");
    await tabsPanel()
      .getByRole("button", { name: "Approve once", exact: true })
      .click();
    await settled(opencodeTitle);
    await tabsPanel().getByText("Approved.").last().waitFor();
    await send("FIXTURE_PERMISSION decline");
    await tabsPanel()
      .getByRole("button", { name: "Decline", exact: true })
      .click();
    await settled(opencodeTitle);
    await tabsPanel().getByText("Declined.").last().waitFor();
    await tabsPanel()
      .getByText("Run command: touch made.txt")
      .first()
      .waitFor();
    await checkpoint("An OpenCode approval card accepts and declines");

    // Stop ends a slow turn.
    await send("FIXTURE_SLOW");
    await until(
      async () => (await opencodeTab()).status === "running",
      "the slow OpenCode turn",
    );
    await tabsPanel()
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await settled(opencodeTitle);
    await tabsPanel()
      .getByText(/^Turn stopped by the host\./)
      .last()
      .waitFor();
    assert.ok((await opencodeRequests("session/cancel")).length >= 1);
    await checkpoint("Stop ends a slow OpenCode turn");

    // Settings lists the local servers and keeps context warnings out of the picker.
    await run.page.setViewportSize({ width: 1024, height: 720 });
    await openSettings("OpenCode");
    await harnessRow("OpenCode").getByText("Ollama · 2 models").waitFor();
    await harnessRow("OpenCode").getByText("LM Studio · not running").waitFor();
    await harnessRow("OpenCode")
      .getByText(/gemma3:12b: Served context is unknown/)
      .waitFor();
    await run.page.screenshot({
      path: join(output, "07-opencode-settings.png"),
    });
    await closeSettings();
    await tabsPanel()
      .getByRole("button", { name: "Model", exact: true })
      .click();
    const modelMenu = tabsPanel().getByRole("menu", { name: "Model" });
    await modelMenu
      .getByRole("menuitemradio", { name: /gemma3:12b/ })
      .waitFor();
    assert.equal(await modelMenu.getByText(/Served context/).count(), 0);
    await run.page.screenshot({ path: join(output, "08-opencode-models.png") });
    await run.page.keyboard.press("Escape");
    await checkpoint(
      "OpenCode Settings shows local servers and warnings that stay out of the picker",
    );

    // A turn running when the app dies reads interrupted, and the next send resumes the session.
    const opencodeSession = (await opencodeTab()).sessionId;
    assert.ok(opencodeSession);
    await send("FIXTURE_PERMISSION before the crash");
    await tabsPanel()
      .getByRole("button", { name: "Approve once", exact: true })
      .waitFor();
    await crashApplication(run.application);
    await launch();
    await selectTab(opencodeTitle);
    await until(
      async () => (await opencodeTab())?.status === "interrupted",
      "the interrupted OpenCode tab",
    );
    await tabsPanel()
      .getByText(/The app restarted during this turn/)
      .last()
      .waitFor();
    await until(
      async () => (await harness("opencode")).auth.state === "signed_in",
      "OpenCode to be ready after the restart",
    );
    await send("Say hello after the restart");
    await settled(opencodeTitle);
    assert.equal(
      (await opencodeRequests("session/resume")).at(-1).params.sessionId,
      opencodeSession,
    );
    assert.equal((await opencodeTab()).sessionId, opencodeSession);
    await checkpoint(
      "A restart marks the OpenCode turn interrupted and the next send resumes its session",
    );

    // App-owned homes: host setup is linked in; credentials and transcripts are not.
    const accounts = join(output, "user-data", "accounts");
    assert.equal(
      await readlink(join(accounts, "claude", "skills")),
      join(hostClaude, "skills"),
    );
    assert.equal(
      await readlink(
        join(accounts, "claude", "projects", "-host-repo", "memory"),
      ),
      join(hostClaude, "projects", "-host-repo", "memory"),
    );
    assert.ok(
      (await lstat(join(accounts, "claude", "settings.json"))).isFile(),
    );
    for (const name of [".credentials.json", ".claude.json"])
      await assert.rejects(
        readlink(join(accounts, "claude", name)),
        undefined,
        `${name} is never linked`,
      );
    assert.equal(
      await readlink(join(accounts, "codex", "config.toml")),
      join(hostCodex, "config.toml"),
    );
    // A host skill shows in the Claude Code tab's command list (AE3).
    await selectTab("Claude Code 1");
    const claudeTab = await tabNamed("Claude Code 1");
    const listed = await run.page.evaluate(
      ([roomId, tabId]) => window.desktop.loadCommands(roomId, tabId),
      [(await room()).id, claudeTab.id],
    );
    assert.ok(
      listed.commands?.some((command) => command.name === "host-skill"),
      "The host skill is listed",
    );
    await checkpoint(
      "Harness homes link the host's setup, and a host skill is listed in the Claude Code tab",
    );

    // Sign out during a running turn stops it and names only the harness (AE5).
    await send("FIXTURE_SLOW keep running");
    await until(
      async () => (await tabNamed("Claude Code 1")).status === "running",
      "the slow Claude Code turn",
    );
    await openSettings("Claude Code");
    await harnessRow("Claude Code")
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await harnessRow("Claude Code")
      .getByRole("group", { name: "Sign out of Claude Code" })
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await until(
      async () => (await harness("claude")).auth.state === "signed_out",
      "Claude Code to sign out",
    );
    await closeSettings();
    await until(
      async () => (await tabNamed("Claude Code 1")).status === "unavailable",
      "the Claude Code tab to show signed out",
    );
    await tabsPanel()
      .getByText(/Signed out of Claude Code\./)
      .waitFor();
    assert.doesNotMatch(
      await tabsPanel().innerText(),
      /fixture@example\.invalid/,
    );
    await tabsPanel()
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await until(
      async () => (await tabNamed("Claude Code 1")).status === "idle",
      "Claude Code to sign in again",
    );
    await send("Hello after signing in again");
    await settled("Claude Code 1");
    await checkpoint(
      "Sign out stops a running Claude Code turn, and signing in again resumes sending",
    );

    // A pending Codex sign-in can be cancelled (AE4).
    await writeFile(`${codexState}.login-hang`, "");
    await openSettings("Codex");
    await harnessRow("Codex")
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await until(
      async () => (await harness("codex")).auth.state === "signed_out",
      "Codex to sign out",
    );
    await harnessRow("Codex")
      .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
      .click();
    await until(
      async () => (await harness("codex")).auth.state === "signing_in",
      "the Codex sign-in to start",
    );
    await harnessRow("Codex")
      .getByRole("button", { name: "Cancel sign-in", exact: true })
      .click();
    await until(
      async () => (await harness("codex")).auth.state === "signed_out",
      "the Codex sign-in to cancel",
    );
    assert.equal((await harness("codex")).auth.message, "Sign-in cancelled.");
    assert.deepEqual(
      (await codexRequests("account/login/cancel")).map(
        (entry) => entry.params.loginId,
      ),
      ["fixture-login"],
    );
    await rm(`${codexState}.login-hang`);
    await harnessRow("Codex")
      .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
      .click();
    await until(
      async () => (await harness("codex")).auth.state === "signed_in",
      "Codex to sign in again",
    );
    await closeSettings();
    await checkpoint(
      "Cancel ends a pending Codex sign-in, and signing in again works",
    );

    // Launches carry the app's homes and no host credential (R2); nothing leaks (R12).
    const claudeLaunches = (await readFile(`${claudeState}.log`, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(claudeLaunches.length);
    for (const launch of claudeLaunches) {
      assert.equal(launch.configDir, join(accounts, "claude"));
      assert.ok(!launch.envKeys.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    }
    const codexLaunches = (await readFile(codexLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "launch");
    for (const launch of codexLaunches)
      assert.equal(launch.env.CODEX_HOME, join(accounts, "codex"));
    const captured = [JSON.stringify(await snapshot())];
    /** Every app file, read without following links into the host's folders. */
    async function appFiles(root) {
      const found = [];
      for (const name of await readdir(root)) {
        const path = join(root, name);
        const info = await lstat(path);
        if (info.isDirectory()) found.push(...(await appFiles(path)));
        else if (info.isFile()) found.push(path);
      }
      return found;
    }
    for (const file of [
      ...(await appFiles(join(output, "user-data"))),
      `${claudeState}.log`,
      codexLog,
      opencodeLog,
      join(output, "latest-snapshot.yml"),
    ])
      captured.push((await readFile(file)).toString("latin1"));
    for (const secret of SECRETS)
      assert.ok(
        captured.every((text) => !text.includes(secret)),
        `${secret} must not appear in app state, logs, or snapshots`,
      );
    assert.deepEqual(
      { claude: await tree(hostClaude), codex: await tree(hostCodex) },
      hostBefore,
      "The host's Claude Code and Codex folders are unchanged",
    );
    await checkpoint(
      "Launches use app homes without host credentials, nothing leaks, and host folders are unchanged",
    );

    // Nothing left the app beyond the Codex sign-in page: no terminal, no remote requests.
    const external = await run.application.evaluate(() => globalThis.external);
    assert.deepEqual(
      external.filter(
        ([kind, url]) =>
          !(
            kind === "openExternal" &&
            url === "https://auth.openai.com/authorize?state=fixture"
          ),
      ),
      [],
    );
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
