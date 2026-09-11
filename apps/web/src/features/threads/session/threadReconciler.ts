import type {
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";

export type CanonicalThreadSnapshot = {
    threadId: string;
    status: RunStatus;
    runBy: RunMessageAuthor | null;
    messages: Array<{ seq: number; message: RunUIMessage }>;
};

export type ThreadHint = {
    kind: string;
    threadId?: unknown;
    [key: string]: unknown;
};

type Key = `${string}:${string}`;

type RefreshState = {
    inFlight: Promise<void> | null;
    again: boolean;
    generation: number;
};

type ReconcilerOptions = {
    fetchThread(
        roomId: string,
        threadId: string,
        from: number,
    ): Promise<CanonicalThreadSnapshot>;
    apply(
        roomId: string,
        threadId: string,
        snapshot: CanonicalThreadSnapshot,
    ): void;
    clear?(roomId: string, threadId: string): void;
    fail?(roomId: string, threadId: string, error: unknown): void;
    begin?(roomId: string, threadId: string): void;
    from?(roomId: string, threadId: string): number;
};

/** Coordinates authorized reads. Realtime payloads are never applied as data. */
export class ThreadReconciler {
    private readonly refreshes = new Map<Key, RefreshState>();
    private readonly relevant = new Map<
        Key,
        { roomId: string; threadId: string }
    >();
    private readonly running = new Set<Key>();
    private readonly expanded = new Set<Key>();
    private current: { roomId: string; threadId: string } | null = null;

    constructor(private readonly options: ReconcilerOptions) {}

    select(roomId: string, threadId: string) {
        const previous = this.current;
        this.current = { roomId, threadId };
        this.setRelevant(roomId, threadId, true);
        if (previous !== null) this.prune(previous.roomId, previous.threadId);
    }

    selected() {
        return this.current;
    }

    clearSelection() {
        const previous = this.current;
        this.current = null;
        if (previous !== null) this.prune(previous.roomId, previous.threadId);
    }

    setRunning(roomId: string, threadId: string, running: boolean) {
        const key = threadKey(roomId, threadId);
        if (running) this.running.add(key);
        else this.running.delete(key);
        this.setRelevant(roomId, threadId, running);
        if (!running) this.prune(roomId, threadId);
    }

    setExpanded(roomId: string, threadId: string, expanded: boolean) {
        const key = threadKey(roomId, threadId);
        if (expanded) this.expanded.add(key);
        else this.expanded.delete(key);
        this.setRelevant(roomId, threadId, expanded);
        if (!expanded) this.prune(roomId, threadId);
    }

    setRelevant(roomId: string, threadId: string, relevant: boolean) {
        const key = threadKey(roomId, threadId);
        if (relevant) this.relevant.set(key, { roomId, threadId });
        else if (
            this.current?.roomId !== roomId ||
            this.current.threadId !== threadId
        ) {
            this.relevant.delete(key);
        }
    }

    hint(roomId: string, hint: ThreadHint): Promise<void> {
        if (typeof hint.threadId !== "string") return Promise.resolve();
        const key = threadKey(roomId, hint.threadId);
        if (!this.relevant.has(key)) return Promise.resolve();
        return this.refresh(roomId, hint.threadId);
    }

    refresh(roomId: string, threadId: string): Promise<void> {
        const key = threadKey(roomId, threadId);
        let state = this.refreshes.get(key);
        if (state === undefined) {
            state = { inFlight: null, again: false, generation: 0 };
            this.refreshes.set(key, state);
        }
        if (state.inFlight !== null) {
            state.again = true;
            state.generation += 1;
            return state.inFlight;
        }

        state.inFlight = this.runRefresh(roomId, threadId, state).finally(
            () => {
                state!.inFlight = null;
            },
        );
        return state.inFlight;
    }

    async poll() {
        await Promise.all(
            [...this.relevant.values()].map(({ roomId, threadId }) =>
                this.refresh(roomId, threadId),
            ),
        );
    }

    private async runRefresh(
        roomId: string,
        threadId: string,
        state: RefreshState,
    ) {
        do {
            state.again = false;
            const generation = ++state.generation;
            try {
                this.options.begin?.(roomId, threadId);
                const snapshot = await this.options.fetchThread(
                    roomId,
                    threadId,
                    this.options.from?.(roomId, threadId) ?? 0,
                );
                if (
                    generation === state.generation &&
                    snapshot.threadId === threadId
                ) {
                    this.options.apply(roomId, threadId, snapshot);
                }
            } catch (error) {
                if (generation !== state.generation) continue;
                if (isAuthorizationDenial(error)) {
                    this.options.clear?.(roomId, threadId);
                    this.relevant.delete(threadKey(roomId, threadId));
                } else {
                    this.options.fail?.(roomId, threadId, error);
                }
            }
        } while (state.again);
    }

    private prune(roomId: string, threadId: string) {
        const key = threadKey(roomId, threadId);
        const selected =
            this.current?.roomId === roomId &&
            this.current.threadId === threadId;
        if (!selected && !this.running.has(key) && !this.expanded.has(key)) {
            this.relevant.delete(key);
        }
    }
}

export function threadKey(roomId: string, threadId: string): Key {
    return `${roomId}:${threadId}`;
}

function isAuthorizationDenial(error: unknown) {
    if (typeof error !== "object" || error === null || !("status" in error)) {
        return false;
    }
    const status = Number((error as { status: unknown }).status);
    return status === 401 || status === 403 || status === 404;
}
