import test from "node:test";
import assert from "node:assert/strict";
import { outsideCheckout, toolSummary, TurnEvents } from "./events";

test("assistant text starts a new item after each tool call and thoughts stay reasoning", () => {
  const events = new TurnEvents("turn");
  const chunk = (text: string, thought = false) =>
    events.map({
      sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
      content: { type: "text", text },
    });
  const [first] = chunk("Looking");
  const [thought] = chunk("hmm", true);
  events.map({
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "src/a.ts",
    kind: "read",
  });
  const [after] = chunk("Done");
  assert.equal(first!.type === "text" && first.kind, "assistant");
  assert.equal(thought!.type === "text" && thought.kind, "reasoning");
  assert.notEqual(
    first!.type === "text" && first.item,
    after!.type === "text" && after.item,
  );
});

test("a tool keeps one item across updates with a one-line summary and output as detail", () => {
  const events = new TurnEvents("turn");
  events.map({
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "npm test\n  --watch",
    kind: "execute",
  });
  const [update] = events.map({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "failed",
    content: [
      { type: "content", content: { type: "text", text: "1 failing" } },
    ],
  });
  assert.deepEqual(update, {
    type: "tool",
    item: "call_1",
    summary: "npm test --watch (failed)",
    detail: "1 failing",
  });
  assert.equal(toolSummary("src/a.ts", "edit"), "Edit src/a.ts");
  const [write] = events.map({
    sessionUpdate: "tool_call",
    toolCallId: "call_2",
    title: "write",
    kind: "edit",
    locations: [{ path: "/repo/hello.txt" }],
  });
  assert.equal(write!.type === "tool" && write.summary, "Edit /repo/hello.txt");
  assert.deepEqual(
    events.map({ sessionUpdate: "usage_update", used: 1, size: 2 }),
    [],
  );
});

test("outside-checkout requests are told apart from shell and edits", () => {
  assert.equal(
    outsideCheckout({ kind: "other", rawInput: { parentDir: "/etc" } }),
    true,
  );
  assert.equal(
    outsideCheckout({
      kind: "other",
      rawInput: { command: "ls /etc", directories: ["/etc"] },
    }),
    true,
  );
  assert.equal(
    outsideCheckout({ kind: "execute", rawInput: { command: "ls" } }),
    false,
  );
  assert.equal(
    outsideCheckout({ kind: "edit", rawInput: { filepath: "a.ts" } }),
    false,
  );
});
