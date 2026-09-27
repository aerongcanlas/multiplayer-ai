// Codex tab end to end. By default it uses the Codex fixture and a loopback download server to
// cover in-app ChatGPT sign-in. With `--live --repository <path>` it downloads the pinned Codex,
// uses the machine's real Codex sign-in, and runs one read-only plan-mode turn for the release check.
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import assert from "node:assert/strict";
import { startProgramServer } from "./programs-fixture.mjs";
import {
  appDirectory,
  createRun,
  fingerprint,
  fixtureRepository,
  outputDirectory,
  testEnvironment,
} from "./e2e-support.mjs";

const live = process.argv.includes("--live");
const argument = process.argv.indexOf("--repository");
if (live && argument < 0)
  throw new Error(
    "A live test requires an explicitly supplied --repository path.",
  );
const output = await outputDirectory(`codex-${live ? "live-" : ""}`);
const repository = live
  ? resolve(process.argv[argument + 1])
  : join(output, "repository");
if (!live)
  await fixtureRepository(repository, { readme: "Desktop Codex fixture\n" });
// A live run must leave the chosen repository exactly as it was.
const before = await fingerprint(repository);
const programs = live
  ? undefined
  : await startProgramServer(join(output, "manifest.json"));

const run = createRun({
  output,
  // The fixture starts signed out so the in-app sign-in runs.
  environment: testEnvironment(
    {
      MP_TEST_USER_DATA: join(output, "user-data"),
      ...(live
        ? {}
        : {
            MP_TEST_CODEX_FIXTURE: join(
              appDirectory,
              "scripts/codex-fixture.mjs",
            ),
            MP_TEST_HARNESS_MANIFEST: join(output, "manifest.json"),
            MP_FIXTURE_STATE: join(output, "codex-threads.json"),
          }),
    },
    ["MP_FIXTURE_SIGNED_IN"],
  ),
  timeout: 30_000,
  poll: 200,
  consoleErrors: false,
  prepare: (application) =>
    application.evaluate(({ shell }) => {
      globalThis.opened = [];
      shell.openExternal = async (url) => {
        globalThis.opened.push(url);
      };
    }),
});
const { launch, checkpoint, snapshot, until, send, selectRepository } = run;
const codex = async () =>
  (await snapshot()).harnesses.find((item) => item.id === "codex");
const tab = async () => (await snapshot()).rooms[0].tabs[0];

await run.execute(
  async () => {
    await launch();
    await selectRepository(repository);
    await run.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await run.page
      .getByRole("menuitem", { name: "Codex", exact: true })
      .click();
    await until(
      async () => ["ready"].includes((await codex()).program.state),
      "the managed Codex download",
      live ? 20 * 60_000 : 30_000,
    );
    await checkpoint(
      `Managed Codex ${(await codex()).program.version} downloaded and verified`,
    );

    if (!live) {
      await until(
        async () => (await codex()).auth.state === "signed_out",
        "the signed-out state",
      );
      await run.page
        .getByRole("region", { name: "AI tabs" })
        .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
        .click();
      await until(
        async () => (await codex()).auth.state === "signed_in",
        "the ChatGPT sign-in",
      );
      assert.deepEqual(
        await run.application.evaluate(() => globalThis.opened),
        ["https://auth.openai.com/authorize?state=fixture"],
      );
      await checkpoint(
        "In-app ChatGPT sign-in opens only the allowlisted login page",
      );
    }

    await until(
      async () => (await tab()).status === "idle",
      "a ready Codex tab",
      90_000,
    );
    const models = (await codex()).models;
    assert.ok(models.length > 0);
    await checkpoint(`Codex lists ${models.length} models for this account`);

    // A read-only plan-mode turn: the access mode keeps Codex in its read-only sandbox.
    await run.page.getByRole("checkbox", { name: "Plan mode" }).check();
    await until(async () => (await tab()).loadout.planMode, "plan mode");
    await send(
      live
        ? "Plan only: in one sentence, what is this repository for? Do not edit files or run commands that change anything."
        : "Plan the change",
    );
    await run.settled(tab, "the plan-mode turn", live ? 10 * 60_000 : 30_000);
    assert.equal((await tab()).status, "idle");
    if (live) {
      // A real model may answer a simple question without a plan item.
      await run.page
        .getByText(/^Turn completed\./)
        .last()
        .waitFor();
      await checkpoint("A plan-mode turn completes");
    } else {
      await run.page.getByRole("region", { name: "Plan" }).last().waitFor();
      await checkpoint("A plan-mode turn completes with a plan");
    }

    if (!live) {
      // A spawned sub-agent thread's approval reaches the tab and its card completes.
      const tabs = run.page.getByRole("region", { name: "AI tabs" });
      const cards = run.page
        .getByRole("region", { name: "Agent tasks" })
        .locator(".agent-card");
      await run.page.getByRole("checkbox", { name: "Plan mode" }).uncheck();
      await until(async () => !(await tab()).loadout.planMode, "plan mode off");
      await send("FIXTURE_AGENTS inspect the checkout");
      await run.settled(tab, "the sub-agent turn");
      const approval = tabs.getByRole("region", {
        name: "Approval for sub-agent Inspect the checkout",
      });
      await approval
        .getByRole("button", { name: "Approve once", exact: true })
        .click();
      await cards
        .filter({ hasText: "Inspect the checkout" })
        .getByText("Found README.md.")
        .waitFor();
      await cards.filter({ hasText: "A short README." }).waitFor();
      await tabs.getByText("The scout reported back.").waitFor();
      await until(
        async () =>
          (await tab()).status === "idle" && !(await tab()).runningAgents,
        "the tab to settle",
      );
      await checkpoint(
        "A Codex sub-agent's approval is answerable after the turn and its card completes",
      );
    }

    if (live) {
      const idle = (label) => run.settled(tab, label, 10 * 60_000);
      // Ask mode routes a write to the tab; declining keeps the repository unchanged.
      await run.page.getByRole("checkbox", { name: "Plan mode" }).uncheck();
      await until(async () => !(await tab()).loadout.planMode, "plan mode off");
      await send(
        "Create a file named approval-check.txt containing the word hi. Do nothing else.",
      );
      await run.page
        .getByRole("region", { name: "Agent approval" })
        .last()
        .getByRole("button", { name: "Decline", exact: true })
        .click({ timeout: 5 * 60_000 });
      await idle("the declined turn");
      await checkpoint(
        "A real write request appears as an approval and can be declined",
      );
      await send("Run `sleep 60` in the shell, then say done.");
      await until(
        async () => (await tab()).status === "running",
        "the long turn",
      );
      await wait(4_000);
      await run.page.getByRole("button", { name: "Stop", exact: true }).click();
      await idle("the stopped turn");
      await run.page
        .getByText(/^Turn stopped by the host\./)
        .last()
        .waitFor();
      await checkpoint("Stop interrupts a real running turn");
    }

    assert.deepEqual(
      await fingerprint(repository),
      before,
      "The repository must not change",
    );
    assert.deepEqual(run.errors, []);
    await checkpoint(
      "The repository is unchanged and the renderer reported no errors",
    );
  },
  { cleanup: () => programs?.close() },
);
