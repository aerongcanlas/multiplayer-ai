import test from "node:test";
import assert from "node:assert/strict";
import { sharedDatabase, alice, bob, eve } from "./shared-fixture.mjs";

test("desktop rooms support current web threads while preserving service-only mutations", async () => {
  const { db, rpc } = await sharedDatabase();
  try {
    const { roomId } = await rpc(alice, {
      type: "room.create",
      name: "Both apps",
    });
    await db.exec("set role service_role");
    const first = await db.query(
      "select * from public.create_ai_thread($1, $2, $3)",
      [roomId, alice, "44444444-4444-4444-8444-444444444444"],
    );
    const second = await db.query(
      "select * from public.create_ai_thread($1, $2, $3)",
      [roomId, alice, "55555555-5555-4555-8555-555555555555"],
    );
    assert.notEqual(first.rows[0].thread_id, second.rows[0].thread_id);
    await assert.rejects(
      db.query("insert into public.ai_thread(room_id) values ($1)", [roomId]),
      /explicit thread creation identity/,
    );
    await db.exec("reset role; set role authenticated");
    await assert.rejects(
      db.query("select * from public.create_ai_thread($1, $2, $3)", [
        roomId,
        alice,
        "66666666-6666-4666-8666-666666666666",
      ]),
      /permission denied/,
    );
    await db.exec("reset role");
    assert.equal((await rpc(alice)).rooms[0].id, roomId);
  } finally {
    await db.close();
  }
});

test("desktop migration enforces shared-room identities and membership in local PostgreSQL", async () => {
  const { db, rpc } = await sharedDatabase();
  try {
    await assert.rejects(rpc(null, undefined, "anon"), /permission denied/);
    await assert.rejects(rpc(null), /Sign in/);
    const created = await rpc(alice, {
      type: "room.create",
      name: "Shared design",
    });
    const roomId = created.roomId;
    assert.equal(created.snapshot.rooms[0].isAdmin, true);
    assert.deepEqual((await rpc(bob)).rooms, []);
    await assert.rejects(
      rpc(bob, { type: "message.send", roomId, text: "Intruder" }),
      /no longer a member/,
    );
    const invite = "a".repeat(64);
    await rpc(alice, { type: "invite.create", roomId, tokenHash: invite });
    const joined = await rpc(bob, {
      type: "room.join",
      tokenHash: invite,
      userId: alice,
    });
    assert.equal(joined.snapshot.userId, bob);
    assert.equal(joined.snapshot.rooms[0].isAdmin, false);
    assert.equal(
      (await rpc(bob, { type: "room.join", tokenHash: invite })).roomId,
      roomId,
    );
    await assert.rejects(
      rpc(eve, { type: "room.join", tokenHash: invite }),
      /already been used/,
    );
    await assert.rejects(
      rpc(bob, { type: "invite.create", roomId, tokenHash: "b".repeat(64) }),
      /Only room admins/,
    );
    const sent = await rpc(bob, {
      type: "message.send",
      roomId,
      text: "Keep context visible",
      authorId: alice,
    });
    const message = sent.snapshot.rooms[0].messages[0];
    assert.equal(message.authorId, bob);
    assert.equal(message.authorName, "Bob");
    assert.equal((await rpc(alice)).rooms[0].messages[0].text, message.text);
    const other = await rpc(alice, {
      type: "room.create",
      name: "Private to Alice",
    });
    const outside = await rpc(alice, {
      type: "message.send",
      roomId: other.roomId,
      text: "Not in shared room",
    });
    const outsideMessage = outside.snapshot.rooms.find(
      (room) => room.id === other.roomId,
    ).messages[0];
    await assert.rejects(
      rpc(bob, {
        type: "suggestion.create",
        roomId,
        messageIds: [outsideMessage.id],
      }),
      /does not belong/,
    );
    const suggested = await rpc(bob, {
      type: "suggestion.create",
      roomId,
      messageIds: [message.id],
      sources: [{ text: "forged" }],
    });
    const suggestion = suggested.snapshot.rooms[0].suggestions[0];
    assert.equal(suggestion.sources[0].text, message.text);
    await rpc(bob, {
      type: "suggestion.edit",
      roomId,
      suggestionId: suggestion.id,
      prompt: "Edited",
      expectedRevision: 1,
    });
    await assert.rejects(
      rpc(bob, {
        type: "suggestion.edit",
        roomId,
        suggestionId: suggestion.id,
        prompt: "Stale",
        expectedRevision: 1,
      }),
      /changed/,
    );
    await db.query(
      "delete from public.room_member where room_id=$1 and member_id=$2",
      [roomId, bob],
    );
    assert.deepEqual((await rpc(bob)).rooms, []);
    await assert.rejects(
      rpc(bob, { type: "message.send", roomId, text: "After removal" }),
      /no longer a member/,
    );
    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("select * from public.desktop_prompt_suggestion"),
      /permission denied/,
    );
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});
