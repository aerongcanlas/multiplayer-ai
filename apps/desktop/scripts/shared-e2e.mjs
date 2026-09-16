import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { sharedDatabase, alice, bob } from "./shared-fixture.mjs";

const require = createRequire(import.meta.url);
const directory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(
  directory,
  "../../output/playwright/shared-" +
    new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(output, { recursive: true });
const { db, rpc } = await sharedDatabase();
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
    if (url.pathname === "/rest/v1/rpc/desktop_room_snapshot")
      res.end(JSON.stringify(await rpc(id)));
    else if (url.pathname === "/rest/v1/rpc/desktop_room_command")
      res.end(JSON.stringify(await rpc(id, body.p_command)));
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
  await client.page.getByRole("status").filter({ hasText: "Synced" }).waitFor();
}
try {
  const first = await launch("alice");
  const second = await launch("bob");
  assert.deepEqual(calls, [], "Signed-out startup makes no Supabase calls");
  await signIn(first, alice);
  await signIn(second, bob);
  checkpoint(
    "Two desktop profiles sign in through PKCE against local fake auth",
  );
  await first.page
    .getByRole("button", { name: "New room", exact: true })
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
  await second.page
    .getByRole("button", { name: "Join with invite", exact: true })
    .click();
  await second.page
    .getByRole("textbox", { name: "Invitation code" })
    .fill(token);
  await second.page
    .getByRole("button", { name: "Join room", exact: true })
    .click();
  await second.page
    .getByRole("heading", { name: "Shared design", exact: true })
    .waitFor();
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
  await db.query(
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
  await writeFile(
    join(output, "report.json"),
    JSON.stringify({ checkpoints, errors, endpoint: url, calls }, null, 2),
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
  await Promise.all(apps.map((app) => app.close().catch(() => {})));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
}
