import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { schemaDatabase } from "@multiplayer-ai/db/testing";
import { buildServer } from "../dist/server.js";
import { databasePool } from "./database.mjs";

test("shared-room HTTP authorization, transactions, snapshots and generated prompts", async () => {
  const db = await schemaDatabase();
  const alice = randomUUID(),
    bob = randomUUID(),
    eve = randomUUID();
  const identities = new Map([
    [alice, "Alice"],
    [bob, "Bob"],
    [eve, "Eve"],
  ]);
  for (const [id, name] of identities)
    await db.query("insert into auth.users values($1, $2, $3::jsonb)", [
      id,
      `${name.toLowerCase()}@example.invalid`,
      JSON.stringify({ name }),
    ]);
  let authOffline = false;
  const auth = createServer((req, res) => {
    const id = req.headers.authorization?.replace("Bearer ", "");
    res.setHeader("Content-Type", "application/json");
    if (authOffline) return res.writeHead(503).end('{"message":"Unavailable"}');
    if (req.url !== "/auth/v1/user" || !identities.has(id))
      return res.writeHead(401).end('{"message":"Invalid token"}');
    res.end(
      JSON.stringify({
        id,
        email: `${identities.get(id).toLowerCase()}@example.invalid`,
      }),
    );
  });
  await new Promise((resolve) => auth.listen(0, "127.0.0.1", resolve));
  const pool = databasePool(db);
  const app = buildServer(
    {
      supabaseUrl: `http://127.0.0.1:${auth.address().port}`,
      publishableKey: "sb_publishable_test",
      databaseUrl: "unused",
    },
    pool,
  );
  app.log.level = "silent";
  async function request(actor, method, url, payload, status = 200) {
    const response = await app.inject({
      method,
      url,
      ...(actor ? { headers: { authorization: `Bearer ${actor}` } } : {}),
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(
      response.statusCode,
      status,
      `${method} ${url}: ${response.body}`,
    );
    assert.equal(response.headers["cache-control"], "no-store");
    return response.json();
  }
  const get = (actor) => request(actor, "GET", "/v1/rooms/snapshot");
  const create = (actor, name) =>
    request(actor, "POST", "/v1/rooms", { name }, 201);
  const invite = (roomId) =>
    request(alice, "POST", `/v1/rooms/${roomId}/invites`, undefined, 201);
  const accept = (actor, token, status = 200) =>
    request(actor, "POST", "/v1/invites/accept", { token }, status);
  try {
    await request(null, "GET", "/v1/rooms/snapshot", undefined, 401);
    await request("forged", "POST", "/v1/rooms", { name: "Forged" }, 401);
    assert.equal(
      (await db.query("select count(*)::int as n from public.room")).rows[0].n,
      0,
    );
    authOffline = true;
    await request(alice, "GET", "/v1/rooms/snapshot", undefined, 503);
    authOffline = false;
    await request(alice, "POST", "/v1/rooms", { name: " ", actor: bob }, 400);
    const { roomId } = await create(alice, "  API room  ");
    const room = (await get(alice)).rooms[0];
    assert.equal(room.name, "API room");
    assert.deepEqual(room.members, [{ id: alice, name: "Alice" }]);
    assert.equal(room.isAdmin, true);
    assert.deepEqual((await get(bob)).rooms, []);
    await request(
      bob,
      "POST",
      `/v1/rooms/${roomId}/messages`,
      { text: "Forbidden" },
      403,
    );
    const { token } = await invite(roomId);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (await db.query("select token_hash from public.room_invite")).rows[0]
        .token_hash,
      createHash("sha256").update(token).digest("hex"),
    );
    await accept(bob, token);
    await accept(bob, token); // A retry by the admitted member is idempotent.
    await accept(eve, token, 409);
    await request(bob, "POST", `/v1/rooms/${roomId}/invites`, {}, 403);
    await request(
      bob,
      "POST",
      `/v1/rooms/${roomId}/messages`,
      { text: "spoof", authorId: alice },
      400,
    );
    const message = await request(
      bob,
      "POST",
      `/v1/rooms/${roomId}/messages`,
      { text: "  Keep conflicting feedback visible.  " },
      201,
    );
    const source = message.snapshot.rooms[0].messages[0];
    assert.equal(source.authorId, bob);
    assert.equal(source.authorName, "Bob");
    assert.equal(source.text, "Keep conflicting feedback visible.");
    const suggestionPath = `/v1/rooms/${roomId}/suggestions`;
    await request(
      alice,
      "POST",
      suggestionPath,
      { messageIds: [source.id, source.id], prompts: ["A"] },
      400,
    );
    await request(
      alice,
      "POST",
      suggestionPath,
      { messageIds: [source.id], prompts: ["A", " "] },
      400,
    );
    await request(
      alice,
      "POST",
      suggestionPath,
      { messageIds: [source.id], prompts: ["A"], sources: [source] },
      400,
    );
    const other = await create(eve, "Private");
    const foreign = await request(
      eve,
      "POST",
      `/v1/rooms/${other.roomId}/messages`,
      { text: "Private feedback" },
      201,
    );
    await request(
      alice,
      "POST",
      suggestionPath,
      {
        messageIds: [foreign.snapshot.rooms[0].messages[0].id],
        prompts: ["A"],
      },
      403,
    );
    const saved = await request(
      bob,
      "POST",
      suggestionPath,
      {
        messageIds: [source.id],
        prompts: [" Generated one ", "Generated two"],
      },
      201,
    );
    const suggestions = saved.snapshot.rooms[0].suggestions;
    assert.deepEqual(suggestions.map((s) => s.prompt).sort(), [
      "Generated one",
      "Generated two",
    ]);
    assert.deepEqual(suggestions[0].sources, [source]);
    const editPath = `${suggestionPath}/${suggestions[0].id}`;
    await request(
      eve,
      "PATCH",
      editPath,
      { prompt: "Unauthorized", expectedRevision: 1 },
      403,
    );
    await request(bob, "PATCH", editPath, {
      prompt: "Author edit",
      expectedRevision: 1,
    });
    await request(
      alice,
      "PATCH",
      editPath,
      { prompt: "Stale", expectedRevision: 1 },
      409,
    );
    const edited = await request(alice, "PATCH", editPath, {
      prompt: "Admin edit",
      expectedRevision: 2,
    });
    assert.equal(
      edited.snapshot.rooms[0].suggestions.find(
        (s) => s.id === suggestions[0].id,
      ).revision,
      3,
    );
    const aliceDraft = await request(
      alice,
      "POST",
      suggestionPath,
      { messageIds: [source.id], prompts: ["Admin draft"] },
      201,
    );
    const aliceSuggestion = aliceDraft.snapshot.rooms[0].suggestions.find(
      (s) => s.authorId === alice,
    );
    await request(
      bob,
      "PATCH",
      `${suggestionPath}/${aliceSuggestion.id}`,
      { prompt: "Not my draft", expectedRevision: 1 },
      403,
    );

    // Force a database failure after the first insert to prove the entire batch rolls back.
    await db.exec(`create function public.test_fail_prompt() returns trigger language plpgsql as $$
      begin if new.prompt = 'FAIL' then raise exception 'PRIVATE DATABASE DETAIL'; end if; return new; end $$;
      create trigger test_fail_prompt before insert on public.desktop_prompt_suggestion
      for each row execute function public.test_fail_prompt();`);
    const failed = await request(
      bob,
      "POST",
      suggestionPath,
      { messageIds: [source.id], prompts: ["Must roll back", "FAIL"] },
      503,
    );
    assert.equal(JSON.stringify(failed).includes("PRIVATE"), false);
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.desktop_prompt_suggestion",
        )
      ).rows[0].n,
      3,
    );
    await db.exec(
      "drop trigger test_fail_prompt on public.desktop_prompt_suggestion; drop function public.test_fail_prompt()",
    );

    const tabId = randomUUID();
    await db.query(
      `insert into public.desktop_tab_share(tab_id, room_id, host_id, device_id, title, harness, model, status, switch_on)
      values($1,$2,$3,'test-device','Shared tab','codex','test-model','idle',false)`,
      [tabId, roomId, bob],
    );
    const current = await get(alice);
    assert.ok(Number.isFinite(Date.parse(current.now)));
    assert.equal(current.rooms[0].sharedTabs[0].tabId, tabId);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      alice,
    ]);
    const legacy = (
      await db.query("select public.desktop_room_snapshot() as snapshot")
    ).rows[0].snapshot;
    assert.deepEqual(
      current.rooms,
      legacy.rooms,
      "HTTP snapshot preserves the existing desktop contract",
    );
    await db.query(
      "update public.desktop_tab_share set status = 'closed' where tab_id = $1",
      [tabId],
    );
    assert.deepEqual((await get(alice)).rooms[0].sharedTabs, []);
    await db.query(
      "update public.desktop_tab_share set status = 'idle' where tab_id = $1",
      [tabId],
    );
    await db.query(
      "delete from public.room_member where room_id = $1 and member_id = $2",
      [roomId, bob],
    );
    assert.deepEqual((await get(bob)).rooms, []);
    assert.deepEqual((await get(alice)).rooms[0].sharedTabs, []);
    await accept(bob, token, 403); // An old accepted invitation cannot restore revoked membership.
    await request(
      bob,
      "POST",
      suggestionPath,
      { messageIds: [source.id], prompts: ["Revoked"] },
      403,
    );

    const emailInvite = await invite(roomId);
    const emailHash = createHash("sha256")
      .update(emailInvite.token)
      .digest("hex");
    await db.query(
      "update public.room_invite set invited_email = 'BOB@example.invalid' where token_hash = $1",
      [emailHash],
    );
    await accept(eve, emailInvite.token, 403);
    await accept(bob, emailInvite.token);
    const expired = await invite(roomId);
    await db.query(
      "update public.room_invite set expires_at = now() - interval '1 second' where token_hash = $1",
      [createHash("sha256").update(expired.token).digest("hex")],
    );
    await accept(eve, expired.token, 400);
    const revoked = await invite(roomId);
    await db.query(
      "update public.room_invite set revoked_at = now() where token_hash = $1",
      [createHash("sha256").update(revoked.token).digest("hex")],
    );
    await accept(eve, revoked.token, 400);
    const contested = await invite(roomId);
    const outcomes = await Promise.all(
      [bob, eve].map((id) =>
        app.inject({
          method: "POST",
          url: "/v1/invites/accept",
          headers: { authorization: `Bearer ${id}` },
          payload: { token: contested.token },
        }),
      ),
    );
    assert.deepEqual(outcomes.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(
      (await get(eve)).rooms.some((r) => r.id === other.roomId),
      true,
    );
    // Only admins delete a room for everyone; any member can leave.
    const doomed = await create(alice, "Doomed");
    const team = await create(alice, "Team");
    const join = async (roomId, actor) =>
      accept(actor, (await invite(roomId)).token);
    await join(doomed.roomId, bob);
    await join(team.roomId, bob);
    await join(team.roomId, eve);
    await request(
      alice,
      "POST",
      `/v1/rooms/${doomed.roomId}/messages`,
      { text: "Goodbye" },
      201,
    );
    await request(bob, "DELETE", `/v1/rooms/${doomed.roomId}`, undefined, 403);
    const deleted = await request(
      alice,
      "DELETE",
      `/v1/rooms/${doomed.roomId}`,
    );
    assert.equal(
      deleted.snapshot.rooms.some((r) => r.id === doomed.roomId),
      false,
    );
    assert.equal(
      (await get(bob)).rooms.some((r) => r.id === doomed.roomId),
      false,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.message where room_id = $1",
          [doomed.roomId],
        )
      ).rows[0].n,
      0,
    );
    await request(
      alice,
      "DELETE",
      `/v1/rooms/${doomed.roomId}`,
      undefined,
      403,
    );
    const left = await request(alice, "POST", `/v1/rooms/${team.roomId}/leave`);
    assert.equal(
      left.snapshot.rooms.some((r) => r.id === team.roomId),
      false,
    );
    const teamFor = async (actor) =>
      (await get(actor)).rooms.find((r) => r.id === team.roomId);
    // The last admin left, so the earliest remaining member becomes admin.
    assert.equal((await teamFor(bob)).isAdmin, true);
    assert.equal((await teamFor(eve)).isAdmin, false);
    assert.deepEqual(
      (await teamFor(eve)).members.map((m) => m.id).sort(),
      [bob, eve].sort(),
    );
    await request(
      alice,
      "POST",
      `/v1/rooms/${team.roomId}/leave`,
      undefined,
      403,
    );
    await request(eve, "POST", `/v1/rooms/${team.roomId}/leave`);
    await request(bob, "POST", `/v1/rooms/${team.roomId}/leave`);
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.room where id = $1",
          [team.roomId],
        )
      ).rows[0].n,
      0,
    );
    await request(
      alice,
      "POST",
      "/v1/rooms/not-a-uuid/messages",
      { text: "invalid" },
      400,
    );
    await request(alice, "GET", "/unknown", undefined, 404);
  } finally {
    await app.close();
    auth.closeAllConnections();
    await new Promise((resolve) => auth.close(resolve));
    await db.close();
  }
});
