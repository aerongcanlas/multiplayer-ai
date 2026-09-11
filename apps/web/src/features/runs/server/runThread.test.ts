import assert from "node:assert/strict";
import test from "node:test";
import { executeOwnedRun, openRunThread } from "./runThread";

test("a rejected finalization never broadcasts completion and closes", async () => {
    const events: unknown[] = [];
    let closed = false;
    const store = {
        finalizeRun: async () => {
            throw new Error("database down");
        },
    };
    const broadcaster = {
        send: async (event: unknown) => {
            events.push(event);
        },
        close: async () => {
            closed = true;
        },
    };
    const thread = openRunThread(
        store as never,
        broadcaster,
        "room",
        "thread",
        { id: "actor", name: "Actor" },
        "run",
    );
    await assert.rejects(thread.finish("finished"), /database down/);
    assert.deepEqual(events, []);
    assert.equal(closed, true);
});

test("completion waits for execution then the snapshot queue", async () => {
    let release!: () => void;
    const delay = new Promise<void>((resolve) => {
        release = resolve;
    });
    const order: string[] = [];
    const pending = executeOwnedRun({
        execute: async () => {
            order.push("executed");
        },
        settled: async () => {
            await delay;
            order.push("persisted");
        },
        finish: async (status) => {
            order.push(status);
            return true;
        },
        requestSignal: new AbortController().signal,
        deadlineSignal: new AbortController().signal,
        reportError() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["executed"]);
    release();
    await pending;
    assert.deepEqual(order, ["executed", "persisted", "finished"]);
});

for (const scenario of [
    "replay failure",
    "persistence failure",
    "request abort",
    "deadline abort",
] as const) {
    test(`${scenario} finalizes only after partial persistence with canonical outcome`, async () => {
        const request = new AbortController();
        const deadline = new AbortController();
        const order: string[] = [];
        const result = await executeOwnedRun({
            execute: async () => {
                if (scenario === "request abort") request.abort();
                if (scenario === "deadline abort") deadline.abort();
                if (scenario === "replay failure")
                    throw new Error("replay failed");
            },
            settled: async () => {
                order.push("partial persisted");
                if (scenario === "persistence failure")
                    throw new Error("persist failed");
            },
            finish: async (status) => {
                order.push(status);
                return true;
            },
            requestSignal: request.signal,
            deadlineSignal: deadline.signal,
            reportError() {},
        });
        const expected = scenario === "request abort" ? "cancelled" : "failed";
        assert.equal(result.status, expected);
        assert.deepEqual(order, ["partial persisted", expected]);
    });
}

test("stale finalization is silent and repeated finalization is harmless", async () => {
    let calls = 0;
    const events: unknown[] = [];
    const store = {
        finalizeRun: async () => {
            calls++;
            return false;
        },
    };
    const broadcaster = {
        send: async (event: unknown) => {
            events.push(event);
        },
        close: async () => {},
    };
    const thread = openRunThread(
        store as never,
        broadcaster,
        "room",
        "thread",
        { id: "actor", name: "Actor" },
        "run",
    );
    await thread.finish("finished");
    await thread.finish("failed");
    assert.equal(calls, 1);
    assert.deepEqual(events, []);
});
