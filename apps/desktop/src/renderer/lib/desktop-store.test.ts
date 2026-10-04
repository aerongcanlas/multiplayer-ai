import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  type Result,
  type Snapshot,
} from "../../shared/contracts";
import {
  acceptSnapshot,
  isInFlight,
  perform,
  readDesktop,
  withRoom,
} from "./desktop-store";

let revision = 0;
const snapshot = (suggestions: string[]): Snapshot => ({
  protocolVersion: PROTOCOL_VERSION,
  revision: ++revision,
  hostId: "host",
  sync: "local-only",
  rooms: [
    {
      id: "room",
      name: "Room",
      createdAt: "",
      workspace: null,
      messages: [],
      tabs: [],
      suggestions: suggestions.map((id) => ({
        id,
        prompt: id,
        revision: 1,
        sources: [],
        status: "draft",
        contextVersion: 1,
        sourceMessageIds: [],
        createdAt: "",
        updatedAt: "",
      })),
    },
  ],
});
const shown = () =>
  readDesktop().snapshot!.rooms[0]!.suggestions.map((item) => item.id);
const hide = (id: string) => (view: Snapshot) =>
  withRoom(view, "room", (room) => ({
    ...room,
    suggestions: room.suggestions.filter((item) => item.id !== id),
  }));
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => (resolve = done));
  return { promise, resolve };
}

test("a repeat with the same key is dropped while the first is in flight", async () => {
  const reply = deferred();
  let calls = 0;
  const run = () => {
    calls++;
    return reply.promise;
  };
  const first = perform(run, { key: "stop" });
  assert.equal(isInFlight("stop"), true);
  assert.equal(await perform(run, { key: "stop" }), null);
  reply.resolve({ ok: true, snapshot: snapshot([]) });
  await first;
  assert.equal(calls, 1);
  assert.equal(isInFlight("stop"), false);
});

test("dismissed suggestions hide at once and delete one by one, in order", async () => {
  acceptSnapshot(snapshot(["a", "b", "c"]));
  const order: string[] = [];
  const replies = new Map<string, ReturnType<typeof deferred>>();
  const remove = (id: string) =>
    perform(
      () => {
        order.push(id);
        const reply = deferred();
        replies.set(id, reply);
        return reply.promise;
      },
      { lane: "suggestions:room", optimistic: hide(id) },
    );
  const a = remove("a");
  const b = remove("b");
  assert.deepEqual(shown(), ["c"]);
  // b waits for a's reply before it is sent.
  assert.deepEqual(order, ["a"]);
  replies.get("a")!.resolve({ ok: true, snapshot: snapshot(["b", "c"]) });
  await a;
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(shown(), ["c"]);
  replies.get("b")!.resolve({ ok: true, snapshot: snapshot(["c"]) });
  await b;
  assert.deepEqual(shown(), ["c"]);
});

test("a failed command rolls its optimistic edit back and shows the error", async () => {
  acceptSnapshot(snapshot(["a"]));
  const reply = deferred();
  const pending = perform(() => reply.promise, { optimistic: hide("a") });
  assert.deepEqual(shown(), []);
  reply.resolve({ ok: false, error: "Suggestion not found in this room." });
  assert.equal(await pending, null);
  assert.deepEqual(shown(), ["a"]);
  assert.equal(readDesktop().error, "Suggestion not found in this room.");
});
