import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@multiplayer-ai/db";
import { threadTestDatabaseConfig } from "../testing/threadTestDatabase";
import { createThreadStore } from "./threadStore";

const config = threadTestDatabaseConfig();
const url = config?.url;
const serviceKey = config?.serviceKey;
const anonKey = config?.anonKey;
const enabled = config !== null;

const service = enabled
  ? createClient<Database>(url!, serviceKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

const createdUsers: string[] = [];
const createdRooms: string[] = [];

after(async () => {
  if (!service) return;
  for (const roomId of createdRooms) {
    await service.from("room").delete().eq("id", roomId);
  }
  for (const userId of createdUsers) {
    await service.auth.admin.deleteUser(userId);
  }
});

async function fixture() {
  assert(service);
  const memberId = randomUUID();
  const otherMemberId = randomUUID();
  const nonmemberId = randomUUID();
  const roomId = randomUUID();
  const password = `Room-${randomUUID()}!aA1`;

  for (const [id, label] of [
    [memberId, "member"],
    [otherMemberId, "other"],
    [nonmemberId, "outsider"],
  ] as const) {
    const { error } = await service.auth.admin.createUser({
      id,
      email: `${label}-${id}@example.invalid`,
      password,
      email_confirm: true,
    });
    assert.equal(error, null);
    createdUsers.push(id);
  }

  assert.equal(
    (
      await service.from("user_profile").insert([
        { id: memberId, name: "Member" },
        { id: otherMemberId, name: "Other member" },
        { id: nonmemberId, name: "Outsider" },
      ])
    ).error,
    null,
  );
  assert.equal(
    (
      await service
        .from("room")
        .insert({ id: roomId, name: "Threads", slug: roomId })
    ).error,
    null,
  );
  createdRooms.push(roomId);
  assert.equal(
    (
      await service.from("room_member").insert([
        { room_id: roomId, member_id: memberId, is_admin: true },
        { room_id: roomId, member_id: otherMemberId, is_admin: false },
      ])
    ).error,
    null,
  );

  return { roomId, memberId, otherMemberId, nonmemberId, password };
}

function textParts(text: string): Json {
  return [{ type: "text", text }];
}

function errorCode(reason: unknown): string | undefined {
  return typeof reason === "object" && reason !== null && "code" in reason
    ? String((reason as { code?: unknown }).code)
    : undefined;
}

test(
  "transactional claims are per-thread, idempotent, fenced, and archive-safe",
  { skip: !enabled },
  async () => {
    assert(service);
    const { roomId, memberId, otherMemberId } = await fixture();
    const store = createThreadStore(service);
    const threadA = await store.create(roomId, memberId, randomUUID());
    const threadB = await store.create(roomId, memberId, randomUUID());

    const messageA = randomUUID();
    const runA = randomUUID();
    const competingRun = randomUUID();
    const claims = await Promise.allSettled([
      store.claimRun({
        roomId,
        threadId: threadA.id,
        actorId: memberId,
        runId: runA,
        userMessageId: messageA,
        parts: textParts("  Explain   the plan  "),
      }),
      store.claimRun({
        roomId,
        threadId: threadA.id,
        actorId: otherMemberId,
        runId: competingRun,
        userMessageId: randomUUID(),
        parts: textParts("Competing prompt"),
      }),
    ]);
    assert.equal(
      claims.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = claims.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    assert.equal(errorCode(rejected?.reason), "55P03");

    const parallel = await store.claimRun({
      roomId,
      threadId: threadB.id,
      actorId: otherMemberId,
      runId: randomUUID(),
      userMessageId: randomUUID(),
      parts: textParts("Independent work"),
    });
    assert.equal(parallel.outcome, "accepted");

    const retry = await store.claimRun({
      roomId,
      threadId: threadA.id,
      actorId: memberId,
      runId: randomUUID(),
      userMessageId: messageA,
      parts: textParts("Must not duplicate"),
    });
    assert.equal(retry.outcome, "already_accepted");
    const historyA = await store.get(roomId, threadA.id, memberId);
    assert.equal(
      historyA.messages.filter((entry) => entry.id === messageA).length,
      1,
    );
    assert.equal(historyA.title, "Explain the plan");
    const incremental = await store.loadFrom(
      roomId,
      threadA.id,
      memberId,
      retry.acceptedMessageSeq,
    );
    assert.equal(incremental.messages.length, 1);
    assert.equal(incremental.messages[0]?.id, messageA);
    assert.equal(incremental.runBy?.id, memberId);

    await assert.rejects(
      store.claimRun({
        roomId,
        threadId: threadB.id,
        actorId: memberId,
        runId: randomUUID(),
        userMessageId: messageA,
        parts: textParts("Foreign collision"),
      }),
      (error: unknown) => errorCode(error) === "23505",
    );

    await assert.rejects(
      store.archive(roomId, threadA.id, memberId),
      (error: unknown) => errorCode(error) === "55P03",
    );

    await store.finalizeRun({
      roomId,
      threadId: threadB.id,
      actorId: otherMemberId,
      runId: parallel.runId,
      status: "finished",
    });
    const archiveRace = await Promise.allSettled([
      store.archive(roomId, threadB.id, memberId),
      store.claimRun({
        roomId,
        threadId: threadB.id,
        actorId: otherMemberId,
        runId: randomUUID(),
        userMessageId: randomUUID(),
        parts: textParts("Archive race"),
      }),
    ]);
    assert.equal(
      archiveRace.filter((result) => result.status === "fulfilled").length,
      1,
    );
  },
);

test(
  "expired ownership is replaced without allowing stale writes or finalization",
  { skip: !enabled },
  async () => {
    assert(service);
    const { roomId, memberId } = await fixture();
    const store = createThreadStore(service);
    const thread = await store.create(roomId, memberId, randomUUID());
    const oldRunId = randomUUID();
    await store.claimRun({
      roomId,
      threadId: thread.id,
      actorId: memberId,
      runId: oldRunId,
      userMessageId: randomUUID(),
      parts: textParts("Old run"),
    });
    assert.equal(
      (
        await service
          .from("ai_thread")
          .update({
            run_started_at: new Date(Date.now() - 361_000).toISOString(),
          })
          .eq("id", thread.id)
      ).error,
      null,
    );
    const newRunId = randomUUID();
    await store.claimRun({
      roomId,
      threadId: thread.id,
      actorId: memberId,
      runId: newRunId,
      userMessageId: randomUUID(),
      parts: textParts("Replacement run"),
    });
    await assert.rejects(
      store.writeMessage({
        roomId,
        threadId: thread.id,
        actorId: memberId,
        runId: oldRunId,
        messageId: randomUUID(),
        role: "assistant",
        parts: textParts("Late output"),
      }),
      (error: unknown) => errorCode(error) === "40001",
    );
    const staleFinalize = await store.finalizeRun({
      roomId,
      threadId: thread.id,
      actorId: memberId,
      runId: oldRunId,
      status: "finished",
    });
    assert.equal(staleFinalize.outcome, "stale");
    assert.equal(
      (await store.get(roomId, thread.id, memberId)).currentRunId,
      newRunId,
    );
  },
);

test(
  "membership, service-only privileges, and manual titles are enforced",
  { skip: !enabled },
  async () => {
    assert(service && url && anonKey);
    const { roomId, memberId, nonmemberId, password } = await fixture();
    const store = createThreadStore(service);
    const thread = await store.create(roomId, memberId, randomUUID());

    await assert.rejects(
      store.get(roomId, thread.id, nonmemberId),
      (error: unknown) => errorCode(error) === "not_member",
    );
    await assert.rejects(
      store.rename(roomId, thread.id, nonmemberId, "Leaked"),
      (error: unknown) => errorCode(error) === "42501",
    );

    const anon = createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    assert.notEqual(
      (
        await anon.rpc("create_ai_thread", {
          p_room_id: roomId,
          p_actor_id: memberId,
          p_creation_id: randomUUID(),
        })
      ).error,
      null,
    );

    const authenticated = createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    assert.equal(
      (
        await authenticated.auth.signInWithPassword({
          email: `member-${memberId}@example.invalid`,
          password,
        })
      ).error,
      null,
    );
    assert.notEqual(
      (
        await authenticated.rpc("create_ai_thread", {
          p_room_id: roomId,
          p_actor_id: memberId,
          p_creation_id: randomUUID(),
        })
      ).error,
      null,
    );

    const organizationThread = await store.create(
      roomId,
      memberId,
      randomUUID(),
    );
    assert.equal(
      (await store.archive(roomId, organizationThread.id, memberId)).outcome,
      "archived",
    );
    assert.equal(
      (await store.get(roomId, organizationThread.id, memberId)).retiredAt ===
        null,
      false,
    );
    assert.equal(
      (await store.restore(roomId, organizationThread.id, memberId)).outcome,
      "restored",
    );

    await Promise.all([
      store.rename(roomId, thread.id, memberId, "Manual title"),
      store.claimRun({
        roomId,
        threadId: thread.id,
        actorId: memberId,
        runId: randomUUID(),
        userMessageId: randomUUID(),
        parts: textParts("Automatic title must lose"),
      }),
    ]);
    const renamed = await store.get(roomId, thread.id, memberId);
    assert.equal(renamed.title, "Manual title");
    assert.equal(renamed.titleSource, "manual");
  },
);

test(
  "creation retries, stable pagination, and archived history use exact identities",
  { skip: !enabled },
  async () => {
    assert(service);
    const { roomId, memberId } = await fixture();
    const store = createThreadStore(service);
    const creationId = randomUUID();
    const first = await store.create(roomId, memberId, creationId);
    const retry = await store.create(roomId, memberId, creationId);
    assert.equal(retry.id, first.id);
    await store.create(roomId, memberId, randomUUID());
    await store.create(roomId, memberId, randomUUID());

    const pageOne = await store.listPage(roomId, memberId, { limit: 2 });
    assert.equal(pageOne.threads.length, 2);
    assert.notEqual(pageOne.nextCursor, null);
    const pageTwo = await store.listPage(roomId, memberId, {
      limit: 2,
      cursor: pageOne.nextCursor!,
    });
    assert.equal(
      pageTwo.threads.some((thread) =>
        pageOne.threads.some((previous) => previous.id === thread.id),
      ),
      false,
    );

    await store.archive(roomId, first.id, memberId);
    const archived = await store.get(roomId, first.id, memberId);
    assert.notEqual(archived.retiredAt, null);
    await assert.rejects(
      store.claimRun({
        roomId,
        threadId: first.id,
        actorId: memberId,
        runId: randomUUID(),
        userMessageId: randomUUID(),
        parts: textParts("Archived write"),
      }),
      (error: unknown) => errorCode(error) === "P0001",
    );
  },
);
