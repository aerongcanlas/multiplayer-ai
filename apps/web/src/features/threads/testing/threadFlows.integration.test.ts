import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { Database, Json } from "@multiplayer-ai/db";
import { createClient } from "@supabase/supabase-js";
import {
    createThreadService,
    ThreadServiceError,
} from "../server/threadService";
import { createThreadStore } from "../server/threadStore";
import { threadTestDatabaseConfig } from "./threadTestDatabase";

const config = threadTestDatabaseConfig();
const enabled = config !== null;
const serviceClient =
    config === null
        ? null
        : createClient<Database>(config.url, config.serviceKey, {
              auth: { autoRefreshToken: false, persistSession: false },
          });
const createdUsers: string[] = [];
const createdRooms: string[] = [];

after(async () => {
    if (serviceClient === null) return;
    for (const roomId of createdRooms) {
        await serviceClient.from("room").delete().eq("id", roomId);
    }
    for (const userId of createdUsers) {
        await serviceClient.auth.admin.deleteUser(userId);
    }
});

test(
    "application service, transactions, history, and member chat stay coherent",
    { skip: !enabled },
    async () => {
        assert(serviceClient);
        const { roomId, memberId, otherMemberId, nonmemberId } =
            await createFixture();
        const store = createThreadStore(serviceClient);
        const service = createThreadService(store);
        const thread = await service.create(roomId, memberId, randomUUID());
        const userMessageId = randomUUID();
        const claim = await store.claimRun({
            roomId,
            threadId: thread.id,
            actorId: memberId,
            runId: randomUUID(),
            userMessageId,
            parts: textParts("Plan the launch"),
        });
        assert.equal(claim.outcome, "accepted");

        const partial = await service.history(
            roomId,
            thread.id,
            otherMemberId,
            claim.acceptedMessageSeq,
        );
        assert.equal(partial.runStatus, "running");
        assert.equal(partial.messages[0]?.id, userMessageId);
        assert.equal(partial.messages[0]?.authorId, memberId);

        const assistantMessageId = randomUUID();
        await store.writeMessage({
            roomId,
            threadId: thread.id,
            actorId: memberId,
            runId: claim.runId,
            messageId: assistantMessageId,
            role: "assistant",
            parts: textParts("Launch plan saved"),
        });
        await store.finalizeRun({
            roomId,
            threadId: thread.id,
            actorId: memberId,
            runId: claim.runId,
            status: "finished",
        });

        await service.update(roomId, thread.id, otherMemberId, {
            action: "rename",
            title: "Manual launch plan",
        });
        await service.update(roomId, thread.id, memberId, {
            action: "archive",
        });
        const archived = await service.list({
            roomId,
            actorId: otherMemberId,
            archived: true,
        });
        assert.equal(
            archived.threads.some(({ id }) => id === thread.id),
            true,
        );
        const retained = await service.get(roomId, thread.id, otherMemberId);
        assert.deepEqual(
            retained.messages.map(({ id }) => id),
            [userMessageId, assistantMessageId],
        );
        assert.equal(retained.title, "Manual launch plan");

        await service.update(roomId, thread.id, memberId, {
            action: "restore",
        });
        const restored = await service.get(roomId, thread.id, memberId);
        assert.deepEqual(restored.messages, retained.messages);
        assert.equal(restored.retiredAt, null);

        const memberChat = await serviceClient
            .from("message")
            .select("id, text, room_id, author_id")
            .eq("room_id", roomId)
            .single();
        assert.equal(memberChat.error, null);
        assert.equal(memberChat.data?.text, "Room-wide context");

        const deniedOperations = await Promise.allSettled([
            service.list({ roomId, actorId: nonmemberId }),
            service.get(roomId, thread.id, nonmemberId),
            service.history(roomId, thread.id, nonmemberId),
            service.create(roomId, nonmemberId, randomUUID()),
            service.update(roomId, thread.id, nonmemberId, {
                action: "rename",
                title: "Leaked",
            }),
            service.update(roomId, thread.id, nonmemberId, {
                action: "archive",
            }),
            service.update(roomId, thread.id, nonmemberId, {
                action: "restore",
            }),
            store.claimRun({
                roomId,
                threadId: thread.id,
                actorId: nonmemberId,
                runId: randomUUID(),
                userMessageId: randomUUID(),
                parts: textParts("Unauthorized"),
            }),
        ]);
        assert.equal(
            deniedOperations.every(
                (result) =>
                    result.status === "rejected" &&
                    (result.reason instanceof ThreadServiceError
                        ? result.reason.status === 404
                        : errorCode(result.reason) === "42501"),
            ),
            true,
        );
    },
);

test(
    "same-thread contention is exclusive while different threads run in parallel",
    { skip: !enabled },
    async () => {
        assert(serviceClient);
        const { roomId, memberId, otherMemberId } = await createFixture();
        const store = createThreadStore(serviceClient);
        const threadA = await store.create(roomId, memberId, randomUUID());
        const threadB = await store.create(roomId, otherMemberId, randomUUID());
        const sameThread = await Promise.allSettled([
            store.claimRun({
                roomId,
                threadId: threadA.id,
                actorId: memberId,
                runId: randomUUID(),
                userMessageId: randomUUID(),
                parts: textParts("Alice"),
            }),
            store.claimRun({
                roomId,
                threadId: threadA.id,
                actorId: otherMemberId,
                runId: randomUUID(),
                userMessageId: randomUUID(),
                parts: textParts("Bob"),
            }),
        ]);
        assert.equal(
            sameThread.filter(({ status }) => status === "fulfilled").length,
            1,
        );
        assert.equal(
            sameThread.some(
                (result) =>
                    result.status === "rejected" &&
                    errorCode(result.reason) === "55P03",
            ),
            true,
        );
        const parallel = await store.claimRun({
            roomId,
            threadId: threadB.id,
            actorId: otherMemberId,
            runId: randomUUID(),
            userMessageId: randomUUID(),
            parts: textParts("Independent"),
        });
        assert.equal(parallel.outcome, "accepted");
    },
);

async function createFixture() {
    assert(serviceClient);
    const memberId = randomUUID();
    const otherMemberId = randomUUID();
    const nonmemberId = randomUUID();
    const roomId = randomUUID();
    for (const [id, label] of [
        [memberId, "member"],
        [otherMemberId, "other"],
        [nonmemberId, "outsider"],
    ] as const) {
        const { error } = await serviceClient.auth.admin.createUser({
            id,
            email: `${label}-${id}@example.invalid`,
            password: `Room-${id}!aA1`,
            email_confirm: true,
        });
        assert.equal(error, null);
        createdUsers.push(id);
    }
    assert.equal(
        (
            await serviceClient.from("user_profile").insert([
                { id: memberId, name: "Member" },
                { id: otherMemberId, name: "Other member" },
                { id: nonmemberId, name: "Outsider" },
            ])
        ).error,
        null,
    );
    assert.equal(
        (
            await serviceClient
                .from("room")
                .insert({ id: roomId, name: "Thread flows", slug: roomId })
        ).error,
        null,
    );
    createdRooms.push(roomId);
    assert.equal(
        (
            await serviceClient.from("room_member").insert([
                { room_id: roomId, member_id: memberId, is_admin: true },
                {
                    room_id: roomId,
                    member_id: otherMemberId,
                    is_admin: false,
                },
            ])
        ).error,
        null,
    );
    assert.equal(
        (
            await serviceClient.from("message").insert({
                room_id: roomId,
                author_id: memberId,
                text: "Room-wide context",
            })
        ).error,
        null,
    );
    return { roomId, memberId, otherMemberId, nonmemberId };
}

function textParts(text: string): Json {
    return [{ type: "text", text }];
}

function errorCode(reason: unknown) {
    return typeof reason === "object" && reason !== null && "code" in reason
        ? String((reason as { code?: unknown }).code)
        : undefined;
}
