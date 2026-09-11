"use client";

import {
    RUN_THREAD_EVENT,
    parseRunThreadEvent,
    runThreadTopic,
} from "@multiplayer-ai/domain";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { createClient } from "@/lib/supabase/client";
import {
    ThreadReconciler,
    type CanonicalThreadSnapshot,
} from "./threadReconciler";
import {
    ThreadSessionRegistry,
    type ThreadSession,
} from "./threadSessionRegistry";

const FALLBACK_REFRESH_MS = 5_000;
const CANONICAL_REFRESH_TIMEOUT_MS = 15_000;

type SessionContextValue = {
    registry: ThreadSessionRegistry;
    reconciler: ThreadReconciler;
    /** Select a room thread without remounting the room's live panels. */
    selectThread(roomId: string, threadId: string): void;
    observeRoom(roomId: string): () => void;
    subscribeRoomHints(roomId: string, listener: () => void): () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function ThreadSessionProvider({
    userId,
    children,
}: {
    userId: string;
    children: ReactNode;
}) {
    const supabase = useMemo(() => createClient(), []);
    const [runtime] = useState(() => createSessionRuntime(userId));
    const channels = useRef(
        new Map<string, { channel: RealtimeChannel; observers: number }>(),
    );
    const roomHintListeners = useRef(new Map<string, Set<() => void>>());

    const observeRoom = useCallback(
        (roomId: string) => {
            const current = channels.current.get(roomId);
            if (current !== undefined) {
                current.observers += 1;
                return () => releaseRoom(roomId);
            }

            const channel = supabase
                .channel(runThreadTopic(roomId), {
                    config: { private: true },
                })
                .on("broadcast", { event: RUN_THREAD_EVENT }, ({ payload }) => {
                    const event = parseRunThreadEvent(payload);
                    if (event !== null) {
                        roomHintListeners.current
                            .get(roomId)
                            ?.forEach((listener) => listener());
                        void runtime.reconciler.hint(roomId, event);
                    }
                })
                .subscribe((status) => {
                    if (status === "SUBSCRIBED") {
                        void runtime.reconciler.poll();
                    }
                });
            channels.current.set(roomId, { channel, observers: 1 });
            return () => releaseRoom(roomId);

            function releaseRoom(releasedRoomId: string) {
                const observed = channels.current.get(releasedRoomId);
                if (observed === undefined) return;
                observed.observers -= 1;
                if (observed.observers > 0) return;
                channels.current.delete(releasedRoomId);
                void supabase.removeChannel(observed.channel);
            }
        },
        [runtime, supabase],
    );

    const subscribeRoomHints = useCallback(
        (roomId: string, listener: () => void) => {
            let listeners = roomHintListeners.current.get(roomId);
            if (listeners === undefined) {
                listeners = new Set();
                roomHintListeners.current.set(roomId, listeners);
            }
            listeners.add(listener);
            return () => {
                listeners?.delete(listener);
                if (listeners?.size === 0) {
                    roomHintListeners.current.delete(roomId);
                }
            };
        },
        [],
    );

    const value = useMemo<SessionContextValue>(
        () => ({
            ...runtime,
            selectThread: (roomId, threadId) => {
                runtime.registry.select(roomId, threadId);
                runtime.reconciler.select(roomId, threadId);
            },
            observeRoom,
            subscribeRoomHints,
        }),
        [observeRoom, runtime, subscribeRoomHints],
    );

    useEffect(() => {
        if (runtime.registry.userId !== userId) {
            void runtime.registry.resetForUser(userId);
        }
    }, [runtime, userId]);

    useEffect(() => {
        const refresh = () => {
            if (document.visibilityState === "visible") {
                void runtime.reconciler.poll();
            }
        };
        const interval = window.setInterval(refresh, FALLBACK_REFRESH_MS);
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [runtime]);

    useEffect(
        () => () => {
            void runtime.registry.resetForUser("");
            for (const { channel } of channels.current.values()) {
                void supabase.removeChannel(channel);
            }
            channels.current.clear();
        },
        [runtime, supabase],
    );

    return (
        <SessionContext.Provider value={value}>
            {children}
        </SessionContext.Provider>
    );
}

function createSessionRuntime(userId: string) {
    const runtime: { reconciler?: ThreadReconciler } = {};
    const registry = new ThreadSessionRegistry(userId, {
        onAlreadyAccepted: (roomId, threadId) => {
            void runtime.reconciler?.refresh(roomId, threadId);
        },
    });
    const reconciler = new ThreadReconciler({
        fetchThread: fetchCanonicalThread,
        from: (roomId, threadId) =>
            registry.get(roomId, threadId)?.state.lastSeq ?? 0,
        apply: (roomId, threadId, snapshot) => {
            registry.mergeCanonical(roomId, threadId, snapshot);
            runtime.reconciler?.setRunning(
                roomId,
                threadId,
                snapshot.status === "running",
            );
        },
        begin: (roomId, threadId) => registry.beginLoad(roomId, threadId),
        clear: (roomId, threadId) => registry.deny(roomId, threadId),
        fail: (roomId, threadId, error) =>
            registry.setSyncError(
                roomId,
                threadId,
                error instanceof Error
                    ? error.message
                    : "Could not refresh thread.",
            ),
    });
    runtime.reconciler = reconciler;
    return { registry, reconciler };
}

export function useThreadSessionContext() {
    const value = useContext(SessionContext);
    if (value === null) {
        throw new Error("ThreadSessionProvider is required");
    }
    return value;
}

export function useThreadSession(
    roomId: string,
    threadId: string,
): ThreadSession {
    const { registry } = useThreadSessionContext();
    useSyncExternalStore(
        registry.subscribe,
        registry.snapshot,
        registry.snapshot,
    );
    return registry.ensure(roomId, threadId);
}

async function fetchCanonicalThread(
    roomId: string,
    threadId: string,
    from: number,
): Promise<CanonicalThreadSnapshot> {
    const query = new URLSearchParams({
        roomId,
        threadId,
        from: String(from),
    });
    const response = await fetch(`/api/runs?${query}`, {
        signal: AbortSignal.timeout(CANONICAL_REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw Object.assign(new Error("Could not refresh thread."), {
            status: response.status,
        });
    }
    return (await response.json()) as CanonicalThreadSnapshot;
}
