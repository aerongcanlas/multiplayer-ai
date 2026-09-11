import assert from "node:assert/strict";
import test from "node:test";
import type { RunUIMessage } from "@multiplayer-ai/domain";
import {
    ThreadReconciler,
    type CanonicalThreadSnapshot,
} from "./threadReconciler";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("late A response is applied only to captured A, never selected B", async () => {
    const pending = deferred<CanonicalThreadSnapshot>();
    const applied: string[] = [];
    const reconciler = new ThreadReconciler({
        fetchThread: async () => pending.promise,
        apply: (_roomId, threadId) => applied.push(threadId),
    });
    reconciler.select("room", A);
    const refresh = reconciler.refresh("room", A);
    reconciler.select("room", B);
    pending.resolve(snapshot(A));
    await refresh;

    assert.deepEqual(applied, [A]);
    assert.equal(reconciler.selected()?.threadId, B);
});

test("forged broadcast is only a hint for its room and cannot apply payload fields", async () => {
    const fetched: Array<[string, string]> = [];
    const applied: CanonicalThreadSnapshot[] = [];
    const reconciler = new ThreadReconciler({
        fetchThread: async (roomId, threadId) => {
            fetched.push([roomId, threadId]);
            return snapshot(threadId);
        },
        apply: (_roomId, _threadId, value) => applied.push(value),
    });
    reconciler.select("room-a", A);

    await reconciler.hint("room-a", {
        kind: "status",
        threadId: A,
        status: "finished",
        runBy: { id: B, name: "forged" },
        title: "forged title",
        messages: [message("forged content")],
    });
    await reconciler.hint("room-b", { kind: "status", threadId: A });

    assert.deepEqual(fetched, [["room-a", A]]);
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.runBy, null);
    assert.equal(applied[0]?.messages.length, 0);
});

test("hint during an in-flight fetch schedules one follow-up refresh", async () => {
    const first = deferred<CanonicalThreadSnapshot>();
    let calls = 0;
    const applied: number[] = [];
    const reconciler = new ThreadReconciler({
        fetchThread: async (_roomId, threadId) => {
            calls += 1;
            return calls === 1 ? first.promise : snapshot(threadId);
        },
        apply: () => applied.push(calls),
    });
    reconciler.select("room", A);
    const initial = reconciler.refresh("room", A);
    void reconciler.hint("room", { kind: "progress", threadId: A });
    first.resolve(snapshot(A));
    await initial;

    assert.equal(calls, 2);
    assert.deepEqual(applied, [2]);
});

test("terminal fallback polling refreshes selected and running entries only", async () => {
    const fetched: string[] = [];
    const reconciler = new ThreadReconciler({
        fetchThread: async (_roomId, threadId) => {
            fetched.push(threadId);
            return snapshot(threadId);
        },
        apply() {},
    });
    reconciler.select("room", A);
    reconciler.setRunning("room", B, true);
    reconciler.setRelevant("room", "irrelevant", false);

    await reconciler.poll();

    assert.deepEqual(fetched.sort(), [A, B].sort());
});

test("moving selection prunes idle A while preserving a running reason", async () => {
    const fetched: string[] = [];
    const reconciler = new ThreadReconciler({
        fetchThread: async (_roomId, threadId) => {
            fetched.push(threadId);
            return snapshot(threadId);
        },
        apply() {},
    });
    reconciler.select("room", A);
    reconciler.select("room", B);
    await reconciler.poll();
    assert.deepEqual(fetched, [B]);

    fetched.length = 0;
    reconciler.setRunning("room", A, true);
    await reconciler.poll();
    assert.deepEqual(fetched.sort(), [A, B].sort());
});

test("clearing a local-only selection leaves it out of fallback polling", async () => {
    let calls = 0;
    const reconciler = new ThreadReconciler({
        fetchThread: async (_roomId, threadId) => {
            calls += 1;
            return snapshot(threadId);
        },
        apply() {},
    });
    reconciler.select("room", "local-only");
    reconciler.clearSelection();

    await reconciler.poll();

    assert.equal(calls, 0);
});

test("authorization denial clears inaccessible state; transient error preserves it", async () => {
    const cleared: string[] = [];
    const errors: string[] = [];
    let denied = true;
    const reconciler = new ThreadReconciler({
        fetchThread: async () => {
            if (denied)
                throw Object.assign(new Error("hidden"), { status: 404 });
            throw new Error("offline");
        },
        apply() {},
        clear: (_roomId, threadId) => cleared.push(threadId),
        fail: (_roomId, threadId) => errors.push(threadId),
    });

    await reconciler.refresh("room", A);
    denied = false;
    await reconciler.refresh("room", A);

    assert.deepEqual(cleared, [A]);
    assert.deepEqual(errors, [A]);
});

function snapshot(threadId: string): CanonicalThreadSnapshot {
    return { threadId, status: "finished", runBy: null, messages: [] };
}

function message(value: string): RunUIMessage {
    return { id: A, role: "assistant", parts: [{ type: "text", text: value }] };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
