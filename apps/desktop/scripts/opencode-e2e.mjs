// Live OpenCode release check (opt-in, not part of `pnpm check`): `pnpm test:opencode`.
// Needs Ollama running on 127.0.0.1:11434 with a tool-capable model; `--model <ollama model>`
// picks one. It downloads the pinned OpenCode, then:
//   1. with no local server and no OpenCode login, Settings shows "No models available" (AE8);
//   2. a real Ollama model is listed, edits a file in a scratch repository after one approval,
//      stops on request, and resumes its session after an app restart;
//   3. OpenCode's embedded server refuses a request without its password;
//   4. the injected permission rules hold in the real binary (`permissions.live.test.ts`).
// OpenCode's config, data, and login live in this run's output folder unless `--host-config` is
// passed, which uses the host's own OpenCode setup instead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  appDirectory,
  createRun,
  fixtureRepository,
  outputDirectory,
  testEnvironment,
} from "./e2e-support.mjs";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const tags = await fetch("http://127.0.0.1:11434/api/tags")
  .then((response) => response.json())
  .catch(() => {
    throw new Error(
      "Start Ollama on 127.0.0.1:11434 with a tool-capable model first.",
    );
  });
const output = await outputDirectory("opencode-live-");
const repository = join(output, "repository");
await fixtureRepository(repository, { readme: "OpenCode live check\n" });
const isolated = process.argv.includes("--host-config")
  ? {}
  : Object.fromEntries(
      ["CONFIG", "DATA", "CACHE", "STATE"].map((kind) => [
        `XDG_${kind}_HOME`,
        join(output, "opencode-home", kind.toLowerCase()),
      ]),
    );
for (const folder of Object.values(isolated))
  await mkdir(folder, { recursive: true });
const userData = join(output, "user-data");

/** One app run with its own output folder; all runs share the user data and OpenCode home. */
async function liveRun(name, extra = {}) {
  await mkdir(join(output, name), { recursive: true });
  return createRun({
    output: join(output, name),
    environment: testEnvironment({
      MP_TEST_USER_DATA: userData,
      ...isolated,
      ...extra,
    }),
    timeout: 60_000,
    untilTimeout: 10 * 60_000,
    poll: 500,
    consoleErrors: false,
  });
}

// 1. No local server and no OpenCode login: OpenCode's anonymous free models never count.
const empty = await liveRun("no-local", {
  MP_TEST_OPENCODE_DISCOVERY: JSON.stringify({
    servers: [
      { id: "ollama", label: "Ollama", running: false, models: [] },
      { id: "lmstudio", label: "LM Studio", running: false, models: [] },
    ],
    providers: [],
  }),
});
await empty.execute(async () => {
  await empty.launch();
  const opencode = () => empty.harness("opencode");
  const settings = await empty.openSettings("OpenCode");
  await settings
    .getByRole("button", { name: "Refresh OpenCode", exact: true })
    .click();
  await empty.until(
    async () => (await opencode())?.program.state === "ready",
    "the managed OpenCode download",
  );
  await empty.checkpoint(
    `Managed OpenCode ${(await opencode()).program.version} downloaded and verified`,
  );
  await empty.until(
    async () => (await opencode()).auth.state === "signed_out",
    "OpenCode to report no models",
  );
  await settings.getByText("No models available", { exact: true }).waitFor();
  assert.deepEqual((await opencode()).models, []);
  await empty.page.screenshot({ path: join(output, "no-local.png") });
  await empty.checkpoint(
    "With no local server and no OpenCode login, Settings shows No models available",
  );

  // The injected permission rules, evaluated by the downloaded binary itself.
  const binary = join(
    userData,
    "harnesses",
    "opencode",
    (await opencode()).program.version,
    "package",
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
  execFileSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "exec",
      "tsx",
      "--test",
      "src/supervisor/harnesses/opencode/permissions.live.test.ts",
    ],
    {
      cwd: appDirectory,
      env: { ...process.env, OPENCODE_LIVE_BINARY: binary },
      stdio: "inherit",
    },
  );
  await empty.checkpoint(
    "The real OpenCode keeps host denies and asks for every acting tool",
  );
});

// 2. A real Ollama model edits a file after one approval, stops, and resumes after a restart.
const run = await liveRun("ollama");
const opencode = () => run.harness("opencode");
const tab = async () => (await run.snapshot()).rooms[0].tabs[0];
const panel = () => run.page.getByRole("region", { name: "AI tabs" });
const settled = (label) => run.settled(tab, label, 10 * 60_000);
const listed = (tags.models ?? []).map((model) => model.name);
await run.execute(async () => {
  await run.launch();
  await run.selectRepository(repository);
  await run.newTab("OpenCode");
  await run.until(
    async () => (await tab())?.status === "idle",
    "a ready OpenCode tab",
  );
  const models = (await opencode()).models.map((model) => model.id);
  const wanted = option("--model");
  const model = wanted
    ? `ollama/${wanted}`
    : models.find((id) => id.startsWith("ollama/"));
  assert.ok(
    model && models.includes(model),
    `No tool-capable Ollama model is listed (Ollama has ${listed.join(", ") || "none"}).`,
  );
  const current = await tab();
  if (current.loadout.model !== model)
    await run.page.evaluate(
      ([roomId, tabId, loadout]) =>
        window.desktop.setLoadout(roomId, tabId, loadout),
      [current.roomId, current.id, { ...current.loadout, model }],
    );
  await run.checkpoint(`OpenCode lists ${model} from the local Ollama`);

  // Ask mode: every edit waits on an approval card.
  await run.send(
    "Use your write tool to create the file live-check.txt in the current working directory (use the relative path live-check.txt) containing exactly the word hi. Do nothing else.",
  );
  // Approve each card as it appears until the turn is idle with nothing left to approve.
  let approvals = 0;
  for (;;) {
    const approve = panel()
      .getByRole("button", { name: "Approve once", exact: true })
      .first();
    if (await approve.count()) {
      await approve.click();
      approvals++;
    } else if ((await tab()).status === "idle") break;
    await wait(500);
  }
  await settled("the edit turn");
  assert.ok(approvals >= 1, "The edit asked for approval");
  assert.equal(
    (await readFile(join(repository, "live-check.txt"), "utf8")).trim(),
    "hi",
  );
  await run.checkpoint(
    `A real Ollama model edited a file after ${approvals} approval(s)`,
  );

  // 3. While OpenCode runs, its embedded server refuses a request without the password.
  if (process.platform !== "win32") {
    const listening = execFileSync(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-c", "opencode"],
      { encoding: "utf8" },
    );
    const ports = [...listening.matchAll(/127\.0\.0\.1:(\d+)/g)].map(
      (match) => match[1],
    );
    assert.ok(ports.length > 0, "OpenCode listens on loopback");
    assert.equal(/\*:\d+|0\.0\.0\.0:/.test(listening), false);
    for (const port of ports)
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/session`)).status,
        401,
      );
    await run.checkpoint(
      "OpenCode's loopback server refuses requests without its password",
    );
  }

  // Stop ends a long turn. A small model may answer without running the command, so the prompt
  // is retried until a turn is still running when Stop is pressed.
  let stopped = false;
  for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
    await run.send(
      "Use your bash tool to run the shell command `sleep 120`, then reply with the word done.",
    );
    await wait(2_000);
    const stop = panel().getByRole("button", { name: "Stop", exact: true });
    if ((await tab()).status !== "idle" && (await stop.count())) {
      await stop.click();
      stopped = true;
    }
    await settled("the long turn");
  }
  assert.ok(stopped, "A long turn was still running when Stop was pressed");
  await panel()
    .getByText(/^Turn stopped by the host\./)
    .last()
    .waitFor();
  await run.checkpoint("Stop ends a real running OpenCode turn");

  // A restart resumes the same OpenCode session.
  const session = (await tab()).sessionId;
  assert.ok(session);
  await run.application.close();
  await run.launch();
  await run.until(
    async () => (await opencode())?.auth.state === "signed_in",
    "OpenCode after the restart",
  );
  await run.send("Reply with the single word resumed.");
  await settled("the resumed turn");
  assert.equal((await tab()).sessionId, session);
  assert.notEqual((await tab()).status, "resume_failed");
  await run.checkpoint("After a restart the tab resumes its OpenCode session");
  await run.page.screenshot({ path: join(output, "ollama.png") });
});
