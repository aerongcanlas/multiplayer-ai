import { Chat } from "@ai-sdk/react";
import type {
    ModelKey,
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import { DefaultChatTransport, type ChatStatus } from "ai";
import type { CanonicalThreadSnapshot } from "./threadReconciler";
import { threadKey } from "./threadReconciler";

const DEFAULT_MODEL: ModelKey = "google:gemini-3.6-flash";
const DEFAULT_IDLE_TRANSCRIPTS = 8;

export interface SessionChat {
    messages: RunUIMessage[];
    readonly status: ChatStatus;
    stop(): Promise<void>;
}

export type ThreadSessionState = {
    model: ModelKey;
    draft: string;
    draftRevision: number;
    requestError: string | null;
    syncError: string | null;
    loadState: "idle" | "loading" | "loaded" | "denied";
    status: RunStatus;
    runBy: RunMessageAuthor | null;
    retired: boolean;
    lastSeq: number;
    transcriptEvicted: boolean;
    durable: boolean;
    pendingSubmission: {
        prompt: string;
        userMessageId: string;
        accepted: boolean;
    } | null;
};

export type ThreadSession = {
    roomId: string;
    threadId: string;
    chat: SessionChat;
    state: ThreadSessionState;
    sequenceByMessageId: Map<string, number>;
    lastAccess: number;
};

type RegistryOptions = {
    maxIdleTranscripts?: number;
    chatFactory?: (
        roomId: string,
        threadId: string,
        onAlreadyAccepted: () => void,
    ) => SessionChat;
    onAlreadyAccepted?: (roomId: string, threadId: string) => void;
};

export class ThreadSessionRegistry {
    private readonly sessions = new Map<string, ThreadSession>();
    private readonly listeners = new Set<() => void>();
    private readonly selectionListeners = new Set<() => void>();
    private readonly maxIdleTranscripts: number;
    private readonly chatFactory: NonNullable<RegistryOptions["chatFactory"]>;
    private readonly onAlreadyAccepted?: RegistryOptions["onAlreadyAccepted"];
    private selection: { roomId: string; threadId: string } | null = null;
    private readonly personalSelections = new Map<string, string>();
    private version = 0;
    private selectionVersion = 0;

    constructor(
        public userId: string,
        options: RegistryOptions = {},
    ) {
        this.maxIdleTranscripts =
            options.maxIdleTranscripts ?? DEFAULT_IDLE_TRANSCRIPTS;
        this.onAlreadyAccepted = options.onAlreadyAccepted;
        this.chatFactory = options.chatFactory ?? createSessionChat;
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    snapshot = () => this.version;

    subscribeSelection = (listener: () => void) => {
        this.selectionListeners.add(listener);
        return () => this.selectionListeners.delete(listener);
    };

    selectionSnapshot = () => this.selectionVersion;

    ensure(roomId: string, threadId: string): ThreadSession {
        const key = threadKey(roomId, threadId);
        let session = this.sessions.get(key);
        if (session === undefined) {
            session = {
                roomId,
                threadId,
                chat: this.chatFactory(roomId, threadId, () => {
                    this.onAlreadyAccepted?.(roomId, threadId);
                }),
                state: initialState(),
                sequenceByMessageId: new Map(),
                lastAccess: Date.now(),
            };
            this.sessions.set(key, session);
        } else {
            session.lastAccess = Date.now();
        }
        return session;
    }

    get(roomId: string, threadId: string) {
        return this.sessions.get(threadKey(roomId, threadId));
    }

    select(roomId: string, threadId: string) {
        const changed =
            this.selection?.roomId !== roomId ||
            this.selection.threadId !== threadId;
        this.selection = { roomId, threadId };
        this.personalSelections.set(roomId, threadId);
        this.ensure(roomId, threadId);
        const evicted = this.evictIdleTranscripts(false);
        if (changed || evicted) this.emit();
        if (changed) this.emitSelection();
    }

    selected(roomId: string) {
        return this.personalSelections.get(roomId);
    }

    hydrate(
        roomId: string,
        threadId: string,
        initial: {
            messages?: RunUIMessage[];
            status?: RunStatus;
            runBy?: RunMessageAuthor | null;
            seq?: number;
            retired?: boolean;
            durable?: boolean;
        },
    ) {
        const session = this.ensure(roomId, threadId);
        if (session.state.loadState !== "idle") return;
        session.chat.messages = initial.messages ?? [];
        Object.assign(session.state, {
            status: initial.status ?? "finished",
            runBy: initial.runBy ?? null,
            lastSeq: initial.seq ?? 0,
            retired: initial.retired ?? false,
            loadState: "loaded" as const,
            transcriptEvicted: false,
            durable: initial.durable ?? true,
        });
        this.emit();
    }

    mergeCanonical(
        roomId: string,
        threadId: string,
        snapshot: CanonicalThreadSnapshot,
    ) {
        const session = this.ensure(roomId, threadId);
        const messages = [...session.chat.messages];
        if (
            session.chat.status !== "submitted" &&
            session.chat.status !== "streaming"
        ) {
            for (const incoming of snapshot.messages) {
                let index = messages.findIndex(
                    (message) => message.id === incoming.message.id,
                );
                if (index === -1) {
                    const sameSequenceId = [
                        ...session.sequenceByMessageId.entries(),
                    ].find(([, seq]) => seq === incoming.seq)?.[0];
                    if (sameSequenceId !== undefined) {
                        index = messages.findIndex(
                            (message) => message.id === sameSequenceId,
                        );
                        session.sequenceByMessageId.delete(sameSequenceId);
                    }
                }
                if (index === -1) messages.push(incoming.message);
                else messages[index] = incoming.message;
                session.sequenceByMessageId.set(
                    incoming.message.id,
                    incoming.seq,
                );
            }
            session.chat.messages = messages;
        }
        Object.assign(session.state, {
            status: snapshot.status,
            runBy: snapshot.runBy,
            retired: snapshot.retired ?? session.state.retired,
            lastSeq: Math.max(
                session.state.lastSeq,
                ...snapshot.messages.map(({ seq }) => seq),
            ),
            loadState: "loaded" as const,
            syncError: null,
            transcriptEvicted: false,
        });
        const pending = session.state.pendingSubmission;
        if (
            pending !== null &&
            snapshot.messages.some(
                ({ message }) => message.id === pending.userMessageId,
            )
        ) {
            pending.accepted = true;
        }
        if (snapshot.status !== "running" && pending?.accepted === true) {
            session.state.pendingSubmission = null;
        }
        this.emit();
    }

    setDraft(roomId: string, threadId: string, draft: string) {
        const session = this.ensure(roomId, threadId);
        session.state.draft = draft;
        session.state.draftRevision += 1;
        this.emit();
        return session.state.draftRevision;
    }

    setDraftIfRevision(
        roomId: string,
        threadId: string,
        revision: number,
        draft: string,
    ) {
        const session = this.get(roomId, threadId);
        if (session === undefined || session.state.draftRevision !== revision) {
            return false;
        }
        this.setDraft(roomId, threadId, draft);
        return true;
    }

    clearAcceptedDraft(roomId: string, threadId: string, revision: number) {
        const session = this.get(roomId, threadId);
        if (session === undefined || session.state.draftRevision !== revision) {
            return;
        }
        session.state.draft = "";
        session.state.draftRevision += 1;
        this.emit();
    }

    setModel(roomId: string, threadId: string, model: ModelKey) {
        this.ensure(roomId, threadId).state.model = model;
        this.emit();
    }

    prepareSubmission(roomId: string, threadId: string, prompt: string) {
        const session = this.ensure(roomId, threadId);
        if (session.state.pendingSubmission?.prompt === prompt) {
            return session.state.pendingSubmission.userMessageId;
        }
        const userMessageId = crypto.randomUUID();
        session.state.pendingSubmission = {
            prompt,
            userMessageId,
            accepted: false,
        };
        this.emit();
        return userMessageId;
    }

    promoteLocal(
        roomId: string,
        localThreadId: string,
        durableThreadId: string,
    ) {
        const local = this.ensure(roomId, localThreadId);
        const durable = this.ensure(roomId, durableThreadId);
        Object.assign(durable.state, {
            model: local.state.model,
            draft: local.state.draft,
            draftRevision: local.state.draftRevision,
            requestError: local.state.requestError,
            pendingSubmission: local.state.pendingSubmission,
            durable: true,
            loadState: "loaded" as const,
        });
        if (local.chat.messages.length > 0) {
            durable.chat.messages = [...local.chat.messages];
        }
        if (localThreadId !== durableThreadId) {
            this.sessions.delete(threadKey(roomId, localThreadId));
        }
        this.emit();
        return durable;
    }

    setSyncError(roomId: string, threadId: string, error: string | null) {
        const session = this.get(roomId, threadId);
        if (session === undefined) return;
        session.state.syncError = error;
        this.emit();
    }

    beginLoad(roomId: string, threadId: string) {
        const session = this.ensure(roomId, threadId);
        if (session.state.loadState === "idle") {
            session.state.loadState = "loading";
            this.emit();
        }
    }

    setRequestError(roomId: string, threadId: string, error: string | null) {
        const session = this.get(roomId, threadId);
        if (session === undefined) return;
        session.state.requestError = error;
        this.emit();
    }

    deny(roomId: string, threadId: string) {
        const session = this.get(roomId, threadId);
        if (session === undefined) return;
        session.chat.messages = [];
        Object.assign(session.state, {
            loadState: "denied" as const,
            runBy: null,
            syncError: "Thread is unavailable.",
            lastSeq: 0,
            status: "finished" as const,
            retired: false,
            pendingSubmission: null,
        });
        session.sequenceByMessageId.clear();
        this.emit();
    }

    evictIdleTranscripts(notify = true) {
        const idle = [...this.sessions.values()]
            .filter((session) => !isRunning(session))
            .sort((left, right) => right.lastAccess - left.lastAccess);
        let changed = false;
        for (const session of idle.slice(this.maxIdleTranscripts)) {
            if (
                session.chat.messages.length === 0 &&
                session.state.transcriptEvicted
            ) {
                continue;
            }
            session.chat.messages = [];
            session.state.transcriptEvicted = true;
            changed = true;
        }
        if (changed && notify) this.emit();
        return changed;
    }

    async resetForUser(userId: string) {
        const stops = [...this.sessions.values()]
            .filter(isRunning)
            .map(({ chat }) => chat.stop().catch(() => undefined));
        this.sessions.clear();
        this.selection = null;
        this.personalSelections.clear();
        this.userId = userId;
        this.emit();
        this.emitSelection();
        await Promise.all(stops);
    }

    private emit() {
        this.version += 1;
        this.listeners.forEach((listener) => listener());
    }

    private emitSelection() {
        this.selectionVersion += 1;
        this.selectionListeners.forEach((listener) => listener());
    }
}

function initialState(): ThreadSessionState {
    return {
        model: DEFAULT_MODEL,
        draft: "",
        draftRevision: 0,
        requestError: null,
        syncError: null,
        loadState: "idle",
        status: "finished",
        runBy: null,
        retired: false,
        lastSeq: 0,
        transcriptEvicted: false,
        durable: true,
        pendingSubmission: null,
    };
}

function isRunning(session: ThreadSession) {
    return (
        session.chat.status === "submitted" ||
        session.chat.status === "streaming" ||
        session.state.status === "running"
    );
}

export function createSessionChat(
    roomId: string,
    threadId: string,
    onAlreadyAccepted: () => void,
): SessionChat {
    const transport = new DefaultChatTransport<RunUIMessage>({
        api: "/api/runs",
        fetch: async (input, init) => {
            const response = await globalThis.fetch(input, init);
            if (
                response.ok &&
                response.headers
                    .get("content-type")
                    ?.includes("application/json")
            ) {
                const payload = (await response.clone().json()) as {
                    outcome?: unknown;
                    threadId?: unknown;
                };
                if (
                    payload.outcome === "already_accepted" &&
                    payload.threadId === threadId
                ) {
                    onAlreadyAccepted();
                    return new Response("data: [DONE]\n\n", {
                        headers: {
                            "content-type": "text/event-stream",
                            "x-vercel-ai-ui-message-stream": "v1",
                        },
                    });
                }
            }
            return response;
        },
    });
    return new Chat<RunUIMessage>({
        id: `${roomId}:${threadId}`,
        transport,
        onFinish: onAlreadyAccepted,
        onError: onAlreadyAccepted,
    });
}
