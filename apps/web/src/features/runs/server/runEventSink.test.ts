import assert from "node:assert/strict";
import test from "node:test";
import { createRunEventSink } from "./runEventSink";

function textStream() {
    return new ReadableStream({
        start(controller) {
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "partial",
            });
            controller.enqueue({ type: "text-end", id: "text" });
            controller.close();
        },
    });
}
const writer = {
    write() {},
    merge(stream: ReadableStream) {
        void stream.pipeTo(new WritableStream());
    },
};

test("snapshot persistence failure is reported by settled", async () => {
    const events = createRunEventSink(writer as never, {
        assistantMessageId: "assistant",
        persist: async () => {
            throw new Error("write failed");
        },
    });
    events.sink.merge!(textStream());
    await assert.rejects(events.settled(), /write failed/);
});

test("terminal success stays buffered until owned finalization and can become failure", async () => {
    const chunks: unknown[] = [];
    const events = createRunEventSink(
        {
            ...writer,
            write(chunk: unknown) {
                chunks.push(chunk);
            },
        } as never,
        { assistantMessageId: "assistant", persist: async () => {} },
    );
    events.sink.emit({ kind: "run.finished", runId: "run", text: "answer" });
    await events.settled();
    assert.deepEqual(chunks, []);
    events.finish("failed");
    assert.equal((chunks[0] as { type: string }).type, "data-run.failed");
    events.finish("finished");
    assert.equal(chunks.length, 1);
});

test("settled waits for the delayed final snapshot", async () => {
    let release!: () => void;
    const delay = new Promise<void>((resolve) => {
        release = resolve;
    });
    let persisted = false;
    const events = createRunEventSink(writer as never, {
        assistantMessageId: "assistant",
        persist: async () => {
            await delay;
            persisted = true;
        },
    });
    events.sink.merge!(textStream());
    let settled = false;
    const pending = events.settled().then(() => {
        settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    await pending;
    assert.equal(persisted, true);
});
