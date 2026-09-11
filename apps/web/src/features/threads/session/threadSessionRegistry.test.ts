import assert from "node:assert/strict";
import test from "node:test";
import type { RunUIMessage } from "@multiplayer-ai/domain";
import {
    createSessionChat,
    ThreadSessionRegistry,
    type SessionChat,
} from "./threadSessionRegistry";

class FakeChat implements SessionChat {
    messages: RunUIMessage[] = [];
    status: SessionChat["status"] = "ready";
    stopCalls = 0;

    async stop() {
        this.stopCalls += 1;
    }
}

test("switching observers preserves A while B starts independently", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    const a = registry.ensure("room", "a");
    (a.chat as FakeChat).status = "streaming";

    registry.select("room", "b");
    const b = registry.ensure("room", "b");
    (b.chat as FakeChat).status = "submitted";

    assert.equal(registry.get("room", "a")?.chat, a.chat);
    assert.equal(a.chat.status, "streaming");
    assert.equal(b.chat.status, "submitted");
});

test("same-sequence canonical revisions replace content", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    registry.ensure("room", "thread");
    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "running",
        runBy: null,
        messages: [{ seq: 7, message: message("draft") }],
    });
    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "finished",
        runBy: null,
        messages: [{ seq: 7, message: message("final") }],
    });

    const session = registry.get("room", "thread");
    assert.equal(text(session?.chat.messages[0]), "final");
    assert.equal(session?.state.lastSeq, 7);
});

test("canonical refresh updates remote archive state without discarding history", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    registry.hydrate("room", "thread", {
        messages: [message("kept")],
        retired: false,
    });

    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "finished",
        runBy: null,
        retired: true,
        messages: [],
    });

    const session = registry.get("room", "thread");
    assert.equal(session?.state.retired, true);
    assert.equal(text(session?.chat.messages[0]), "kept");
});

test("same sequence cannot retain two message identities", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    registry.ensure("room", "thread");
    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "running",
        runBy: null,
        messages: [{ seq: 7, message: message("draft") }],
    });
    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "finished",
        runBy: null,
        messages: [
            {
                seq: 7,
                message: {
                    ...message("final"),
                    id: "00000000-0000-4000-8000-000000000002",
                },
            },
        ],
    });

    const messages = registry.get("room", "thread")?.chat.messages;
    assert.equal(messages?.length, 1);
    assert.equal(text(messages?.[0]), "final");
});

test("logout clears drafts and sessions and aborts active transports", async () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    const running = registry.ensure("room", "running");
    (running.chat as FakeChat).status = "streaming";
    registry.setDraft("room", "running", "private prompt");

    await registry.resetForUser("bob");

    assert.equal((running.chat as FakeChat).stopCalls, 1);
    assert.equal(registry.get("room", "running"), undefined);
    assert.equal(registry.userId, "bob");
});

test("idle LRU eviction never evicts a running transcript and retains drafts", () => {
    const registry = new ThreadSessionRegistry("alice", {
        maxIdleTranscripts: 1,
        chatFactory: () => new FakeChat(),
    });
    const running = registry.ensure("room", "running");
    (running.chat as FakeChat).status = "streaming";
    running.chat.messages = [message("working")];
    registry.setDraft("room", "running", "keep running draft");

    const idle = registry.ensure("room", "idle");
    idle.chat.messages = [message("cached")];
    registry.setDraft("room", "idle", "keep idle draft");
    registry.ensure("room", "newer-idle").lastAccess = idle.lastAccess + 1;
    registry.evictIdleTranscripts();

    assert.equal(running.chat.messages.length, 1);
    assert.equal(running.state.draft, "keep running draft");
    assert.equal(idle.chat.messages.length, 0);
    assert.equal(idle.state.draft, "keep idle draft");
    assert.equal(idle.state.transcriptEvicted, true);
});

test("accepted revision clears without overwriting a newer retry edit", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    registry.ensure("room", "thread");
    const submitted = registry.setDraft("room", "thread", "first attempt");
    registry.setDraft("room", "thread", "edited while waiting");

    registry.clearAcceptedDraft("room", "thread", submitted);

    assert.equal(
        registry.get("room", "thread")?.state.draft,
        "edited while waiting",
    );
});

test("a captured suggestion updates only its original unchanged draft", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    const captured = registry.setDraft("room", "a", "draft A");
    registry.setDraft("room", "b", "draft B");

    assert.equal(
        registry.setDraftIfRevision("room", "a", captured, "suggested A"),
        true,
    );
    assert.equal(registry.get("room", "a")?.state.draft, "suggested A");
    assert.equal(registry.get("room", "b")?.state.draft, "draft B");
    assert.equal(
        registry.setDraftIfRevision("room", "a", captured, "late overwrite"),
        false,
    );
    assert.equal(registry.get("room", "a")?.state.draft, "suggested A");
});

test("selection notifies general and navigation observers exactly once", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    let generalNotifications = 0;
    let selectionNotifications = 0;
    registry.subscribe(() => {
        generalNotifications += 1;
    });
    registry.subscribeSelection(() => {
        selectionNotifications += 1;
    });

    registry.select("room", "thread");

    assert.equal(generalNotifications, 1);
    assert.equal(selectionNotifications, 1);
});

test("local fresh sessions remain distinguishable until durable creation", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    registry.hydrate("room", "local", { durable: false });
    registry.hydrate("room", "saved", { durable: true });

    assert.equal(registry.get("room", "local")?.state.durable, false);
    assert.equal(registry.get("room", "saved")?.state.durable, true);
});

test("promoting local fresh state transfers personal state to generated durable id", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    registry.hydrate("room", "local", { durable: false });
    registry.setDraft("room", "local", "keep this");
    registry.setModel("room", "local", "openai:gpt-5-mini");
    const userMessageId = registry.prepareSubmission(
        "room",
        "local",
        "keep this",
    );

    const durable = registry.promoteLocal("room", "local", "generated");

    assert.equal(durable.state.durable, true);
    assert.equal(durable.state.draft, "keep this");
    assert.equal(durable.state.model, "openai:gpt-5-mini");
    assert.equal(
        registry.prepareSubmission("room", "generated", "keep this"),
        userMessageId,
    );
    assert.equal(registry.get("room", "local"), undefined);
});

test("submission id is stable for a retry and rotates for a new prompt", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    const first = registry.prepareSubmission("room", "thread", "one");
    const retry = registry.prepareSubmission("room", "thread", "one");
    const next = registry.prepareSubmission("room", "thread", "two");

    assert.equal(retry, first);
    assert.notEqual(next, first);
});

test("terminal canonical acceptance clears pending id for a later identical turn", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    const accepted = registry.prepareSubmission("room", "thread", "repeat");
    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "finished",
        runBy: null,
        messages: [
            {
                seq: 1,
                message: {
                    id: accepted,
                    role: "user",
                    parts: [{ type: "text", text: "repeat" }],
                },
            },
        ],
    });

    assert.notEqual(
        registry.prepareSubmission("room", "thread", "repeat"),
        accepted,
    );
});

test("running acceptance is remembered until a later terminal incremental read", () => {
    const registry = new ThreadSessionRegistry("alice", {
        chatFactory: () => new FakeChat(),
    });
    const accepted = registry.prepareSubmission("room", "thread", "repeat");
    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "running",
        runBy: null,
        messages: [
            {
                seq: 1,
                message: {
                    id: accepted,
                    role: "user",
                    parts: [{ type: "text", text: "repeat" }],
                },
            },
        ],
    });
    registry.mergeCanonical("room", "thread", {
        threadId: "thread",
        status: "finished",
        runBy: null,
        messages: [],
    });

    assert.notEqual(
        registry.prepareSubmission("room", "thread", "repeat"),
        accepted,
    );
});

test("already-accepted JSON is deliberately completed as an SDK stream", async () => {
    const originalFetch = globalThis.fetch;
    let refreshes = 0;
    globalThis.fetch = async () =>
        Response.json({ outcome: "already_accepted", threadId: "thread" });
    try {
        const chat = createSessionChat("room", "thread", () => {
            refreshes += 1;
        });
        await (chat as import("@ai-sdk/react").Chat<RunUIMessage>).sendMessage(
            message("accepted"),
            { body: {} },
        );

        assert.equal(chat.status, "ready");
        assert.ok(refreshes >= 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function message(value: string): RunUIMessage {
    return {
        id: "00000000-0000-4000-8000-000000000001",
        role: "assistant",
        parts: [{ type: "text", text: value }],
    };
}

function text(value: RunUIMessage | undefined) {
    return value?.parts.find((part) => part.type === "text")?.text;
}
