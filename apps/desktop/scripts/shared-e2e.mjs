import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sharedDatabase, alice, bob } from "./shared-fixture.mjs";
import { startProgramServer } from "./programs-fixture.mjs";
import { fixtureRepository, stubOpenDialog } from "./e2e-support.mjs";
import { buildServer } from "@multiplayer-ai/api";

const require = createRequire(import.meta.url);
const directory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(
  directory,
  "../../output/playwright/shared-" +
    new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(output, { recursive: true });
const programs = await startProgramServer(join(output, "manifest.json"));
const { db, pool, call } = await sharedDatabase();
const sessions = new Map();
let offline = false;
const calls = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  calls.push(url.pathname);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString())
    : {};
  res.setHeader("Content-Type", "application/json");
  try {
    if (url.pathname === "/auth/v1/token") {
      const id = body.auth_code ?? sessions.get(body.refresh_token);
      assert.ok([alice, bob].includes(id));
      assert.ok(body.code_verifier || body.refresh_token);
      const user = {
        id,
        aud: "authenticated",
        role: "authenticated",
        email: `${id}@example.invalid`,
        user_metadata: { name: id === alice ? "Alice" : "Bob" },
        app_metadata: { provider: "github" },
        created_at: new Date().toISOString(),
      };
      const payload = {
        sub: id,
        aud: "authenticated",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = [
        Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "test-signature",
      ].join(".");
      sessions.set(token, id);
      sessions.set("refresh-" + id, id);
      res.end(
        JSON.stringify({
          user,
          access_token: token,
          refresh_token: "refresh-" + id,
          expires_in: 3600,
          token_type: "bearer",
        }),
      );
      return;
    }
    if (url.pathname === "/auth/v1/logout") {
      res.end("{}");
      return;
    }
    if (offline) {
      res.writeHead(503).end(JSON.stringify({ message: "Simulated offline" }));
      return;
    }
    const id = sessions.get(req.headers.authorization?.replace("Bearer ", ""));
    if (!id) {
      res
        .writeHead(401)
        .end(JSON.stringify({ message: "Missing authentication" }));
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      res.end(
        JSON.stringify({
          id,
          email: `${id}@example.invalid`,
          user_metadata: { name: id === alice ? "Alice" : "Bob" },
        }),
      );
      return;
    }
    // Read-along RPCs dispatch PostgREST's named arguments to the PGlite functions.
    if (
      /^\/rest\/v1\/rpc\/desktop_tab_share_(publish|head|pull|reconcile)$/.test(
        url.pathname,
      )
    )
      res.end(
        JSON.stringify(
          await call(id, url.pathname.slice("/rest/v1/rpc/".length), body),
        ),
      );
    else
      res
        .writeHead(404)
        .end(JSON.stringify({ message: "Unexpected test endpoint" }));
  } catch (error) {
    res
      .writeHead(400)
      .end(
        JSON.stringify({ message: error.message, code: error.code ?? "P0001" }),
      );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const api = buildServer(
  {
    supabaseUrl: url,
    publishableKey: "sb_publishable_local_test",
    databaseUrl: "unused",
  },
  pool,
);
api.log.level = "silent";
const apiCalls = [];
let joinGate;
let releaseJoin;
api.addHook("onRequest", async (request) => {
  apiCalls.push(`${request.method} ${request.url}`);
  if (request.method === "POST" && request.url === "/v1/invites/accept")
    await joinGate;
});
const apiUrl = await api.listen({ host: "127.0.0.1", port: 0 });
const apps = [];
const errors = [];
const checkpoints = [];
const checkpoint = (text) => {
  checkpoints.push(text);
  console.log("PASS: " + text);
};
async function launch(name) {
  const env = {
    ...process.env,
    MP_E2E: "1",
    MP_TEST_USER_DATA: join(output, name),
    MP_TEST_SUPABASE_URL: url,
    MP_TEST_API_URL: apiUrl,
    MP_TEST_CODEX_FIXTURE: join(directory, "scripts/codex-fixture.mjs"),
    MP_TEST_HARNESS_MANIFEST: join(output, "manifest.json"),
    MP_FIXTURE_SIGNED_IN: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [directory],
    cwd: directory,
    env,
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  // The system browser launch is intercepted; OAuth completes solely against the loopback fixture.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (value) => {
      globalThis.oauthUrl = value;
    };
  });
  await page
    .getByRole("status")
    .filter({ hasText: "Local supervisor connected" })
    .waitFor();
  return { app, page };
}
async function signIn(client, id) {
  await client.app.evaluate(() => {
    globalThis.oauthUrl = undefined;
  });
  await client.page
    .getByRole("button", { name: "Sign in with GitHub" })
    .click();
  const oauth = await client.app.evaluate(async () => {
    const deadline = Date.now() + 15_000;
    while (typeof globalThis.oauthUrl !== "string") {
      if (Date.now() >= deadline)
        throw new Error("Sign-in did not reach the system browser handoff.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return globalThis.oauthUrl;
  });
  assert.equal(new URL(oauth).origin, url);
  const callback = new URL(new URL(oauth).searchParams.get("redirect_to"));
  callback.searchParams.set("code", id);
  await fetch(callback);
  await client.page.waitForFunction(async () => {
    const result = await window.desktop.getSnapshot();
    return result.ok && result.snapshot.collaboration?.status === "connected";
  });
}
try {
  const first = await launch("alice");
  const second = await launch("bob");
  assert.deepEqual(calls, [], "Signed-out startup makes no Supabase calls");
  await signIn(first, alice);
  await first.page
    .getByRole("button", { name: "Refresh Codex", exact: true })
    .click();
  await first.page
    .getByRole("region", { name: "Harness settings" })
    .getByText(/fixture@example.invalid/)
    .waitFor();
  checkpoint("Room creator signs in through PKCE against local fake auth");
  await first.page
    .getByRole("button", { name: "Add room", exact: true })
    .click();
  await first.page
    .getByRole("textbox", { name: "Room name" })
    .fill("Shared design");
  assert.equal(
    await first.page
      .getByRole("combobox", { name: "Room visibility" })
      .inputValue(),
    "shared",
  );
  await first.page
    .getByRole("button", { name: "Create room", exact: true })
    .click();
  await first.page
    .getByRole("heading", { name: "Shared design", exact: true })
    .waitFor();
  await first.page.getByRole("button", { name: "Invite", exact: true }).click();
  const token = await first.page
    .getByRole("textbox", { name: "Share invitation code" })
    .inputValue();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  await pool.query(
    "update public.room_invite set expires_at=now() - interval '1 second' where token_hash=$1",
    [createHash("sha256").update(token).digest("hex")],
  );
  await second.page
    .getByRole("button", { name: "Add room", exact: true })
    .click();
  const joinDialog = second.page.getByRole("dialog", {
    name: "Add room",
    exact: true,
  });
  await second.page
    .getByRole("button", { name: "Join with invite", exact: true })
    .click();
  await second.page
    .getByRole("textbox", { name: "Invitation code" })
    .fill(token);
  await joinDialog.getByRole("button", { name: "Sign in with GitHub" }).click();
  await joinDialog.getByRole("button", { name: "Cancel sign-in" }).click();
  await joinDialog
    .getByRole("button", { name: "Sign in with GitHub" })
    .waitFor();
  assert.equal(
    await joinDialog
      .getByRole("textbox", { name: "Invitation code" })
      .inputValue(),
    token,
  );
  await signIn(second, bob);
  assert.equal(
    await joinDialog
      .getByRole("textbox", { name: "Invitation code" })
      .inputValue(),
    token,
  );
  assert.equal(
    apiCalls.filter((route) => route === "POST /v1/invites/accept").length,
    0,
    "Sign-in must not automatically join",
  );
  await joinDialog
    .getByRole("textbox", { name: "Invitation code" })
    .fill("invalid");
  assert.equal(
    await joinDialog
      .getByRole("button", { name: "Join room", exact: true })
      .isDisabled(),
    true,
  );
  await joinDialog
    .getByRole("textbox", { name: "Invitation code" })
    .fill(token);
  await joinDialog
    .getByRole("button", { name: "Join room", exact: true })
    .click();
  await joinDialog
    .getByRole("alert")
    .filter({ hasText: "Invitation is invalid, expired, or revoked." })
    .waitFor();
  assert.equal(
    await joinDialog
      .getByRole("textbox", { name: "Invitation code" })
      .inputValue(),
    token,
  );
  await second.page.screenshot({
    path: join(output, "room-expired-invite.png"),
    animations: "disabled",
  });
  await writeFile(
    join(output, "room-expired-invite.yml"),
    await second.page.locator("body").ariaSnapshot(),
  );
  checkpoint(
    "Invite draft survives cancelled and completed sign-in; invalid codes are blocked and expired invites show an inline error",
  );
  await first.page.getByRole("button", { name: "Invite", exact: true }).click();
  await first.page.waitForFunction(
    (previous) =>
      document.querySelector('[aria-label="Share invitation code"]')?.value !==
      previous,
    token,
  );
  const freshToken = await first.page
    .getByRole("textbox", { name: "Share invitation code" })
    .inputValue();
  assert.notEqual(freshToken, token);
  await joinDialog
    .getByRole("textbox", { name: "Invitation code" })
    .fill(` ${freshToken} `);
  // A rejected invitation marks sync offline; refresh through the dialog before retrying.
  const refresh = joinDialog.getByRole("button", {
    name: "Refresh shared rooms",
  });
  if (await refresh.isVisible()) await refresh.click();
  await second.page.waitForFunction(
    async () =>
      (await window.desktop.getSnapshot()).snapshot.collaboration.status ===
      "connected",
  );
  await second.page.screenshot({
    path: join(output, "room-join-ready.png"),
    animations: "disabled",
  });
  joinGate = new Promise((resolve) => {
    releaseJoin = resolve;
  });
  const joinsBefore = apiCalls.filter(
    (route) => route === "POST /v1/invites/accept",
  ).length;
  await second.page
    .getByRole("button", { name: "Join room", exact: true })
    .click();
  await joinDialog
    .getByRole("button", { name: "Joining...", exact: true })
    .waitFor();
  assert.equal(
    await joinDialog
      .getByRole("button", { name: "Joining...", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await joinDialog
      .getByRole("button", { name: "Create", exact: true })
      .isDisabled(),
    true,
  );
  await second.page.keyboard.press("Enter");
  await second.page.keyboard.press("Escape");
  assert.equal(await joinDialog.isVisible(), true);
  releaseJoin();
  joinGate = undefined;
  await second.page
    .getByRole("heading", { name: "Shared design", exact: true })
    .waitFor();
  await joinDialog.waitFor({ state: "hidden" });
  assert.equal(
    apiCalls.filter((route) => route === "POST /v1/invites/accept").length,
    joinsBefore + 1,
  );
  assert.equal(
    await second.page
      .getByRole("button", { name: "Invite", exact: true })
      .count(),
    0,
  );
  checkpoint(
    "Admin creates shared room and single-use invite; second member joins without admin rights",
  );
  await first.page.getByRole("button", { name: "Close invitation" }).click();
  await second.page
    .getByRole("textbox", { name: "Group chat message" })
    .fill("Keep selected feedback visible");
  await second.page
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await first.page
    .getByRole("paragraph")
    .filter({ hasText: /^Keep selected feedback visible$/ })
    .waitFor();
  await first.page
    .getByRole("checkbox", {
      name: "Select message: Keep selected feedback visible",
    })
    .check();
  await first.page.getByRole("button", { name: "Suggest prompts" }).click();
  await first.page
    .getByText(
      "Add a dark mode toggle, persist the selected theme, and verify it survives a restart.",
      { exact: true },
    )
    .waitFor();
  await second.page
    .getByRole("button", { name: "Use prompt", exact: true })
    .waitFor();
  assert.equal(
    await second.page
      .getByRole("button", { name: "Edit", exact: true })
      .isEnabled(),
    false,
  );
  await first.page.getByRole("button", { name: "Edit", exact: true }).click();
  await first.page
    .getByRole("textbox", { name: "Edit suggested prompt" })
    .fill("Review selected feedback before implementation.");
  await first.page.getByRole("button", { name: "Save edit" }).click();
  await second.page
    .getByText("Review selected feedback before implementation.", {
      exact: true,
    })
    .waitFor();
  checkpoint(
    "Messages, canonical source attribution, and edited suggestions sync across members",
  );
  await first.page.screenshot({ path: join(output, "shared-room.png") });
  await second.page.screenshot({ path: join(output, "member-room.png") });
  const state = await first.page.evaluate(() => window.desktop.getSnapshot());
  const roomId = state.snapshot.rooms.find(
    (room) => room.name === "Shared design",
  ).id;
  assert.equal(JSON.stringify(state).includes("access_token"), false);
  assert.equal(JSON.stringify(state).includes("refresh_token"), false);
  const encrypted = await readFile(
    join(output, "alice", "supabase-session.bin"),
  );
  assert.equal(encrypted.includes(Buffer.from("refresh-" + alice)), false);
  checkpoint(
    "Tokens remain outside renderer snapshots and are encrypted on disk",
  );

  // Spectator Mission Control: the host's plan state and sub-agent cards follow the shared tab
  // in a member's main area, view-only.
  const SECRET = "q8Zr2mVx4TnL7pWc";
  const tabsOf = (page) => page.getByRole("region", { name: "AI tabs" });
  const missionOf = (page) =>
    page.getByRole("region", { name: "Mission Control" });
  const tasksOf = (page) =>
    missionOf(page).getByRole("region", { name: "Agent tasks" });
  const leadOf = (page) =>
    missionOf(page).getByRole("region", { name: "Lead context" });
  const cardOf = (page, task) =>
    tasksOf(page).locator(".agent-card").filter({ hasText: task });
  const hostTab = async () =>
    (
      await first.page.evaluate(() => window.desktop.getSnapshot())
    ).snapshot.rooms
      .find((room) => room.id === roomId)
      .tabs.find((tab) => tab.title === "Codex 1");
  const until = async (check, label) => {
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  // An idle shared tab is pulled on room refreshes, so the viewer refreshes until it shows.
  const seen = (locator) =>
    until(async () => {
      if (await locator.first().isVisible()) return true;
      await second.page
        .getByRole("button", { name: "Refresh shared rooms" })
        .click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return locator.first().isVisible();
    }, "the viewer to show " + locator);
  const hostSend = async (text) => {
    await tabsOf(first.page)
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(text);
    await tabsOf(first.page)
      .getByRole("button", { name: "Send", exact: true })
      .click();
  };
  const hostApproval = () =>
    tabsOf(first.page).getByRole("region", {
      name: "Approval for sub-agent Inspect the checkout",
    });
  const readAlongSwitch = () =>
    tabsOf(first.page).getByRole("switch", { name: /Read-along/ });

  const repository = join(output, "repository");
  await fixtureRepository(repository, { readme: "Shared fixture\n" });
  await stubOpenDialog(first.app, repository);
  await first.page
    .getByRole("button", { name: "Select repository", exact: true })
    .click();
  await tabsOf(first.page)
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await first.page
    .getByRole("menuitem", { name: "Codex", exact: true })
    .click();
  await until(async () => (await hostTab())?.status === "idle", "the host tab");
  // The sub-agent starts, and waits on the host, before anything is shared.
  await hostSend("FIXTURE_AGENTS FIXTURE_AGENT_SECRET");
  await hostApproval().waitFor();
  await until(
    async () => (await hostTab()).status === "idle",
    "the host's first turn to end",
  );
  await cardOf(first.page, "Inspect the checkout")
    .getByText("Running")
    .waitFor();
  await readAlongSwitch().check();
  await until(async () => (await hostTab()).readAlong, "read-along to turn on");

  // The viewer's own Mission Control, before any shared tab is open.
  await tabsOf(second.page)
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await second.page
    .getByRole("menuitem", { name: "Codex", exact: true })
    .click();
  const ownChip = tabsOf(second.page).locator(
    ".tab-chip:not(.tab-shared) [role=tab]",
  );
  await ownChip.waitFor();
  await tasksOf(second.page)
    .getByText(/No sub-agents in this tab yet/)
    .waitFor();
  const sharedChip = tabsOf(second.page)
    .getByRole("group", { name: "Shared by Alice" })
    .getByRole("tab", { name: /Codex 1/ });
  await seen(sharedChip);
  await sharedChip.click();
  // Covers AE1, AE5, AE7: the host's data, a mid-run card, and a host that is needed.
  await missionOf(second.page)
    .getByText(/Alice · Codex 1/)
    .waitFor();
  const joined = cardOf(second.page, "Inspect the checkout");
  await seen(joined);
  await joined.getByText("Running", { exact: true }).waitFor();
  await joined.getByText("Joined mid-run").waitFor();
  await tasksOf(second.page).getByText("Needs the host").waitFor();
  await leadOf(second.page).getByText("Alice", { exact: true }).waitFor();
  await leadOf(second.page).getByText("Codex", { exact: true }).waitFor();
  await leadOf(second.page).getByText("Waiting on the host").first().waitFor();
  // The sub-agent that finished before the switch is not shared.
  assert.equal(await tasksOf(second.page).locator(".agent-card").count(), 1);
  // Covers AE3, AE7: the card is no control, nothing opens, and nothing can be approved.
  assert.equal(await tasksOf(second.page).getByRole("button").count(), 0);
  await joined.click();
  assert.equal(
    await tabsOf(second.page)
      .getByRole("heading", { name: "Inspect the checkout" })
      .count(),
    0,
  );
  assert.equal(
    await second.page.getByRole("button", { name: /Approve|Decline/ }).count(),
    0,
  );
  assert.equal(
    await tabsOf(second.page)
      .getByRole("textbox", { name: "Message", exact: true })
      .count(),
    0,
  );
  // Prompt suggestions stay the member's own while the shared tab is open.
  await missionOf(second.page)
    .getByRole("button", { name: "Use prompt", exact: true })
    .waitFor();
  await second.page.screenshot({
    path: join(output, "spectator-mid-run.png"),
    animations: "disabled",
  });
  checkpoint(
    "A viewer's Mission Control shows the host's mid-run sub-agent, view-only, and that the host is needed",
  );

  // Covers AE2, AE4: the card completes live, with its summary masked.
  await hostApproval()
    .getByRole("button", { name: "Approve once", exact: true })
    .click();
  await joined.getByText("Completed", { exact: true }).waitFor();
  await joined.getByText("Found README.md. OPENAI_API_KEY=•••").waitFor();
  await joined.getByText("Joined mid-run").waitFor();
  await until(
    async () =>
      (await tasksOf(second.page).getByText("Needs the host").count()) === 0,
    "the needs-the-host mark to clear",
  );

  // A turn inside the window: its cards arrive under a new turn, one running and one settled.
  await until(
    async () => (await hostTab()).status === "idle",
    "the woken lead to finish",
  );
  await hostSend("FIXTURE_AGENTS");
  await hostApproval().last().waitFor();
  await until(
    async () =>
      (await tasksOf(second.page).locator(".agent-card").count()) === 3,
    "the second turn's cards",
  );
  const latest = tasksOf(second.page).locator("details.agent-turn").first();
  await latest.getByText("Running", { exact: true }).waitFor();
  await latest.getByText("Completed", { exact: true }).waitFor();
  assert.equal(await latest.getByText("Joined mid-run").count(), 0);
  await tasksOf(second.page).getByText("Needs the host").waitFor();
  await missionOf(second.page)
    .getByText(/1 sub-agent running/)
    .waitFor();
  await hostApproval()
    .last()
    .getByRole("button", { name: "Approve once", exact: true })
    .click();
  await until(
    async () =>
      (await latest.getByText("Completed", { exact: true }).count()) === 2,
    "the second turn's sub-agent to complete",
  );
  // No unmasked credential and no entry of a sub-agent's own transcript reached the viewer or
  // the database; a sub-agent shows only as its card, with its final summary.
  const viewerText = await second.page.locator("body").innerText();
  assert.equal(viewerText.includes(SECRET), false);
  assert.equal(viewerText.includes("A short README."), true);
  const stored = await pool.query(
    "select kind, body::text as body from public.desktop_tab_share_entry",
  );
  assert.equal(
    stored.rows.some((row) => row.body.includes(SECRET)),
    false,
  );
  assert.equal(
    stored.rows.some((row) => /agentKey|"reasoning"/.test(row.body)),
    false,
  );
  assert.equal(stored.rows.filter((row) => row.kind === "agent").length, 3);
  await second.page.screenshot({
    path: join(output, "spectator-completed.png"),
    animations: "disabled",
  });
  checkpoint(
    "Shared sub-agent cards complete live with masked summaries, grouped by turn",
  );

  // Covers AE1: back on the viewer's own tab, Mission Control is the viewer's own again.
  await ownChip.click();
  await tasksOf(second.page)
    .getByText(/No sub-agents in this tab yet/)
    .waitFor();
  assert.equal(await tasksOf(second.page).locator(".agent-card").count(), 0);
  assert.equal(await missionOf(second.page).getByText(/Alice/).count(), 0);
  await leadOf(second.page).getByText("Act", { exact: true }).waitFor();

  // Covers AE6: read-along off leaves the cards as ended history.
  await until(
    async () => (await hostTab()).status === "idle",
    "the host's turns to end",
  );
  await readAlongSwitch().uncheck();
  await until(
    async () => !(await hostTab()).readAlong,
    "read-along to turn off",
  );
  await sharedChip.click();
  await seen(
    tasksOf(second.page).getByText(
      "The host turned read-along off. These sub-agents stay as history.",
    ),
  );
  assert.equal(await tasksOf(second.page).locator(".agent-card").count(), 3);
  await leadOf(second.page).getByText("Ended").first().waitFor();
  await ownChip.click();
  checkpoint(
    "Leaving the shared tab restores the viewer's own Mission Control, and an ended share keeps its cards",
  );

  offline = true;
  await second.page
    .getByRole("button", { name: "Refresh shared rooms" })
    .click();
  await second.page
    .getByRole("status")
    .filter({ hasText: /^Offline$/ })
    .waitFor();
  assert.equal(
    await second.page
      .getByRole("textbox", { name: "Group chat message" })
      .isEnabled(),
    false,
  );
  offline = false;
  await second.page
    .getByRole("button", { name: "Refresh shared rooms" })
    .click();
  await second.page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  checkpoint(
    "Offline state disables shared mutations and refresh restores access",
  );
  await second.app.close();
  apps.splice(apps.indexOf(second.app), 1);
  const restored = await launch("bob");
  await restored.page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  await restored.page
    .getByRole("heading", { name: "Shared design", exact: true })
    .waitFor();
  checkpoint("Encrypted session restores shared rooms after desktop restart");
  await pool.query(
    "delete from public.room_member where room_id=$1 and member_id=$2",
    [roomId, bob],
  );
  await restored.page
    .getByRole("button", { name: "Refresh shared rooms" })
    .click();
  await restored.page
    .getByRole("heading", { name: "My workspace", exact: true })
    .waitFor();
  assert.equal(
    await restored.page.getByText("Shared design", { exact: true }).count(),
    0,
  );
  checkpoint("Revoked membership removes room contents on the next sync");
  await first.page
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await first.page
    .getByRole("button", { name: "Sign in with GitHub" })
    .waitFor();
  assert.equal(
    await first.page.getByText("Shared design", { exact: true }).count(),
    0,
  );
  await signIn(first, bob);
  assert.equal(
    await first.page.getByText("Shared design", { exact: true }).count(),
    0,
  );
  checkpoint(
    "Sign-out clears shared views and switching accounts reveals no prior-account data",
  );
  assert.deepEqual(errors, []);
  for (const route of [
    "GET /v1/rooms/snapshot",
    "POST /v1/rooms",
    "POST /v1/invites/accept",
    `POST /v1/rooms/${roomId}/invites`,
    `POST /v1/rooms/${roomId}/messages`,
    `POST /v1/rooms/${roomId}/suggestions`,
  ])
    assert.ok(apiCalls.includes(route), `Desktop uses ${route}`);
  assert.ok(
    apiCalls.some((route) =>
      route.startsWith(`PATCH /v1/rooms/${roomId}/suggestions/`),
    ),
  );
  assert.equal(
    calls.some((path) => /desktop_(room_|save_generated)/.test(path)),
    false,
    "Room operations use Fastify instead of RPCs",
  );
  checkpoint(
    "All seven Fastify endpoints serve the desktop workflow without room RPC calls",
  );
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      { checkpoints, errors, endpoint: apiUrl, calls, apiCalls },
      null,
      2,
    ),
  );
  console.log("Artifacts: " + output);
} catch (error) {
  for (let i = 0; i < apps.length; i++) {
    const page = await apps[i].firstWindow();
    await page
      .screenshot({ path: join(output, `failure-${i}.png`) })
      .catch(() => {});
    await writeFile(
      join(output, `failure-${i}.txt`),
      await page.locator("body").ariaSnapshot(),
    ).catch(() => {});
  }
  throw error;
} finally {
  releaseJoin?.();
  await Promise.all(apps.map((app) => app.close().catch(() => {})));
  await api.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  await programs.close();
}
