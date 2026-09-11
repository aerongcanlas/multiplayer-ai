import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSummary } from "@multiplayer-ai/domain";
import { ThreadSessionRegistry } from "../../session/threadSessionRegistry";
import {
    applyThreadPage,
    beginThreadPageLoad,
    createRoomThreadNavigationState,
    failThreadPageLoad,
    removeThreadFromNormalList,
    resolveThreadSelection,
    retainSelectedSummary,
    setRoomExpanded,
    setThreadNavigationView,
    visibleThreadSummaries,
    selectionAfterCreation,
    selectionFromLocation,
    threadMutationError,
} from "./threadNavigationState";

const roomId = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("explicit inaccessible selection never falls back", () => {
    const result = resolveThreadSelection({
        explicitThreadId: A,
        lastSelectedThreadId: B,
        normalThreads: [summary(B)],
        authorizedIds: new Set([B]),
    });
    assert.deepEqual(result, { kind: "denied", threadId: A });
});

test("an empty successful room is a local fresh draft and performs no write", () => {
    const state = applyThreadPage(
        beginThreadPageLoad(createRoomThreadNavigationState()),
        { threads: [], nextCursor: null },
    );
    assert.equal(state.status, "ready");
    assert.deepEqual(
        resolveThreadSelection({ normalThreads: state.summaries }),
        {
            kind: "fresh",
            threadId: null,
        },
    );
});

test("selection priority is explicit, personal, then newest normal", () => {
    const threads = [summary(A, "2026-09-11T01:00:00.000Z"), summary(B)];
    assert.deepEqual(
        resolveThreadSelection({
            explicitThreadId: A,
            lastSelectedThreadId: B,
            normalThreads: threads,
        }),
        { kind: "selected", threadId: A },
    );
    assert.deepEqual(
        resolveThreadSelection({
            lastSelectedThreadId: A,
            normalThreads: threads,
        }),
        { kind: "selected", threadId: A },
    );
    assert.deepEqual(resolveThreadSelection({ normalThreads: threads }), {
        kind: "selected",
        threadId: B,
    });
});

test("pagination is deduplicated and collapse does not change selection", () => {
    let state = applyThreadPage(createRoomThreadNavigationState(), {
        threads: [summary(A)],
        nextCursor: "next",
    });
    state = setRoomExpanded(state, true);
    state = applyThreadPage(state, {
        threads: [summary(A, "2026-09-11T00:00:00.000Z"), summary(B)],
        nextCursor: null,
    });
    state = setRoomExpanded(state, false);
    assert.equal(state.summaries.length, 2);
    assert.equal(state.expanded, false);
    assert.equal(
        resolveThreadSelection({
            lastSelectedThreadId: A,
            normalThreads: state.summaries,
        }).threadId,
        A,
    );
});

test("archiving normal selected row retains it for reading and restore view", () => {
    let state = applyThreadPage(createRoomThreadNavigationState(), {
        threads: [summary(A), summary(B)],
        nextCursor: null,
    });
    state = removeThreadFromNormalList(retainSelectedSummary(state, A), A);
    assert.equal(
        state.summaries.some((thread) => thread.id === A),
        false,
    );
    assert.equal(
        visibleThreadSummaries(state).some(
            (thread) => thread.id === A && thread.retiredAt !== null,
        ),
        true,
    );
    state = setThreadNavigationView(state, "archived");
    state = applyThreadPage(state, {
        threads: [{ ...summary(A), retiredAt: "2026-09-11T02:00:00.000Z" }],
        nextCursor: null,
    });
    assert.equal(state.view, "archived");
    assert.equal(state.summaries[0]?.retiredAt !== null, true);
});

test("initial failure is not empty, transient refresh retains known rows, auth clears cache", () => {
    const initial = failThreadPageLoad(
        beginThreadPageLoad(createRoomThreadNavigationState()),
        "Try again",
        500,
    );
    assert.equal(initial.status, "error");
    assert.equal(initial.summaries.length, 0);
    let known = applyThreadPage(createRoomThreadNavigationState(), {
        threads: [summary(A)],
        nextCursor: null,
    });
    known = failThreadPageLoad(known, "Offline", 503);
    assert.equal(known.summaries.length, 1);
    known = failThreadPageLoad(known, "No longer a member", 403);
    assert.equal(known.summaries.length, 0);
    assert.equal(known.retainedSelection, null);
});

test("creation changes only initiating browser selection", () => {
    assert.equal(selectionAfterCreation(A, B, true), B);
    assert.equal(selectionAfterCreation(A, B, false), A);
});

test("history addresses exact thread including back and forward", () => {
    const path = `/rooms/${roomId}/room`;
    assert.equal(selectionFromLocation(`${path}?thread=${A}`, roomId), A);
    assert.equal(selectionFromLocation(`${path}?thread=${B}`, roomId), B);
    assert.equal(selectionFromLocation(`${path}?thread=${A}`, roomId), A);
    assert.equal(
        selectionFromLocation(`${path}?thread=invalid`, roomId),
        "invalid",
    );
    assert.equal(
        selectionFromLocation(`/rooms/elsewhere/room?thread=${B}`, roomId),
        undefined,
    );
});

test("personal selection survives pagination and an archived selection", () => {
    assert.deepEqual(
        resolveThreadSelection({
            lastSelectedThreadId: A,
            normalThreads: [summary(B)],
        }),
        { kind: "selected", threadId: A },
    );
});

test("a concurrent busy archive has an understandable conflict", () => {
    assert.match(
        threadMutationError(409, { code: "busy" }),
        /busy.*finish|running.*finish/i,
    );
});

test("back and forward restore the same Chat and draft; room return remembers personal selection", () => {
    const registry = new ThreadSessionRegistry("alice");
    const a = registry.ensure(roomId, A);
    registry.setDraft(roomId, A, "draft A");
    registry.setDraft(roomId, B, "draft B");
    for (const thread of [A, B, A, B]) {
        registry.select(
            roomId,
            selectionFromLocation(
                `/rooms/${roomId}/room?thread=${thread}`,
                roomId,
            )!,
        );
        assert.equal(
            registry.get(roomId, thread)?.state.draft,
            thread === A ? "draft A" : "draft B",
        );
    }
    registry.select("another-room", "another-thread");
    assert.equal(registry.selected(roomId), B);
    assert.equal(registry.get(roomId, A)?.chat, a.chat);
});

function summary(
    id: string,
    createdAt = "2026-09-11T02:00:00.000Z",
): ThreadSummary {
    return {
        id,
        roomId,
        createdAt,
        retiredAt: null,
        title: "New thread",
        titleSource: "default",
        runStatus: "finished",
        currentRunId: null,
    };
}
