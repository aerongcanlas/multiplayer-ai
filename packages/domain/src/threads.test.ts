import assert from "node:assert/strict";
import test from "node:test";
import { decodeThreadCursor, encodeThreadCursor } from "./threads";

test("thread cursors are opaque and round-trip", () => {
    const cursor = {
        createdAt: "2026-09-11T04:00:00.000Z",
        id: crypto.randomUUID(),
    };
    const encoded = encodeThreadCursor(cursor);
    assert.equal(encoded.includes("{"), false);
    assert.deepEqual(decodeThreadCursor(encoded), cursor);
    assert.equal(decodeThreadCursor("not-a-cursor"), null);
});
