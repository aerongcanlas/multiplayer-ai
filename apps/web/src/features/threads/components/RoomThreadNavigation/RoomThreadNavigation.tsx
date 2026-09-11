"use client";

import type {
    ThreadPage,
    ThreadSummary,
    UpdateThreadRequest,
} from "@multiplayer-ai/domain";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    Button,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
} from "@/components/ui";
import {
    JoinRoomLink,
    roomHref,
} from "@/features/rooms/components/JoinRoomLink";
import type { JoinedRoom } from "@/features/rooms/types/room";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { markRoomVisited } from "@/features/rooms/actions/markRoomVisited";
import { useThreadSessionContext } from "../../session/ThreadSessionProvider";
import {
    applyThreadPage,
    beginThreadPageLoad,
    createRoomThreadNavigationState,
    failThreadPageLoad,
    removeThreadFromNormalList,
    replaceThreadPage,
    retainSelectedSummary,
    setRoomExpanded,
    setThreadNavigationView,
    visibleThreadSummaries,
    threadMutationError,
    type RoomThreadNavigationState,
    type ThreadNavigationView,
} from "./threadNavigationState";
import { ThreadRow } from "./ThreadRow";

type Props = { rooms: JoinedRoom[]; onNavigate?: () => void };

export function RoomThreadNavigation({ rooms, onNavigate }: Props) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const {
        registry,
        reconciler,
        observeRoom,
        subscribeRoomHints,
        selectThread: selectSessionThread,
    } = useThreadSessionContext();
    useSyncExternalStore(
        registry.subscribeSelection,
        registry.selectionSnapshot,
        registry.selectionSnapshot,
    );
    const currentRoomId = pathname.match(/^\/rooms\/([^/]+)/)?.[1];
    const explicitThreadId = searchParams.get("thread") ?? undefined;
    const [states, setStates] = useState<
        Map<string, RoomThreadNavigationState>
    >(
        () =>
            new Map(
                rooms.map((room) => [
                    room.id,
                    createRoomThreadNavigationState(),
                ]),
            ),
    );
    const requestIds = useRef(new Map<string, number>());
    const statesRef = useRef(states);
    const pageDepth = useRef(new Map<string, number>());
    const inFlight = useRef(new Set<string>());
    const queued = useRef(
        new Map<string, { view: ThreadNavigationView; cursor?: string }>(),
    );
    useEffect(() => {
        statesRef.current = states;
    }, [states]);

    const getState = useCallback(
        (roomId: string) =>
            states.get(roomId) ?? createRoomThreadNavigationState(),
        [states],
    );

    const loadRoom = useCallback(
        async (roomId: string, view: ThreadNavigationView, cursor?: string) => {
            const key = roomId;
            if (inFlight.current.has(key)) {
                const pending = queued.current.get(key);
                const currentView = statesRef.current.get(roomId)?.view;
                if (
                    pending === undefined ||
                    view !== currentView ||
                    cursor !== undefined ||
                    pending.cursor === undefined
                ) {
                    queued.current.set(key, { view, cursor });
                }
                return;
            }
            inFlight.current.add(key);
            const requestId = (requestIds.current.get(key) ?? 0) + 1;
            requestIds.current.set(key, requestId);
            setStates((current) => {
                const next = new Map(current);
                const previous =
                    next.get(roomId) ?? createRoomThreadNavigationState(view);
                next.set(
                    roomId,
                    cursor === undefined
                        ? beginThreadPageLoad(
                              previous.view === view
                                  ? previous
                                  : setThreadNavigationView(previous, view),
                          )
                        : beginThreadPageLoad(previous),
                );
                return next;
            });
            try {
                if (statesRef.current.get(roomId)?.view !== view)
                    pageDepth.current.set(roomId, 1);
                const body: ThreadPage = { threads: [], nextCursor: null };
                let pageCursor = cursor;
                const pages =
                    cursor === undefined
                        ? (pageDepth.current.get(roomId) ?? 1)
                        : 1;
                for (let index = 0; index < pages; index++) {
                    const query = new URLSearchParams({
                        archived: String(view === "archived"),
                    });
                    if (pageCursor !== undefined)
                        query.set("cursor", pageCursor);
                    const response = await fetch(
                        `/api/rooms/${roomId}/threads?${query}`,
                    );
                    const page = (await response.json()) as ThreadPage & {
                        error?: string;
                    };
                    if (!response.ok)
                        throw Object.assign(
                            new Error(page.error ?? "Could not load threads."),
                            { status: response.status },
                        );
                    body.threads.push(...page.threads);
                    body.nextCursor = page.nextCursor;
                    if (page.nextCursor === null) break;
                    pageCursor = page.nextCursor;
                }
                if (cursor !== undefined)
                    pageDepth.current.set(
                        roomId,
                        (pageDepth.current.get(roomId) ?? 1) + 1,
                    );
                if (requestIds.current.get(key) !== requestId) return;
                setStates((current) => {
                    const next = new Map(current);
                    const previous =
                        next.get(roomId) ??
                        createRoomThreadNavigationState(view);
                    next.set(
                        roomId,
                        cursor === undefined
                            ? replaceThreadPage(previous, body as ThreadPage)
                            : applyThreadPage(previous, body as ThreadPage),
                    );
                    return next;
                });
            } catch (error) {
                if (requestIds.current.get(key) !== requestId) return;
                const status =
                    typeof error === "object" &&
                    error !== null &&
                    "status" in error
                        ? Number((error as { status: unknown }).status)
                        : undefined;
                if (status === 401 || status === 403 || status === 404) {
                    const selected = registry.selected(roomId);
                    if (selected !== undefined) registry.deny(roomId, selected);
                }
                setStates((current) => {
                    const next = new Map(current);
                    const previous =
                        next.get(roomId) ??
                        createRoomThreadNavigationState(view);
                    next.set(
                        roomId,
                        failThreadPageLoad(
                            previous,
                            error instanceof Error
                                ? error.message
                                : "Could not load threads.",
                            status,
                        ),
                    );
                    return next;
                });
            } finally {
                inFlight.current.delete(key);
            }
        },
        [registry],
    );

    const observedRooms = rooms
        .filter(
            (room) =>
                states.get(room.id)?.expanded || room.id === currentRoomId,
        )
        .map((room) => room.id)
        .join(",");
    useEffect(() => {
        const ids = observedRooms.split(",").filter(Boolean);
        const refresh = () => {
            if (document.visibilityState !== "visible") return;
            for (const id of ids)
                void loadRoom(id, statesRef.current.get(id)?.view ?? "normal");
        };
        const cleanups = ids.flatMap((id) => [
            observeRoom(id),
            subscribeRoomHints(id, () => {
                if (document.visibilityState === "visible")
                    void loadRoom(
                        id,
                        statesRef.current.get(id)?.view ?? "normal",
                    );
            }),
        ]);
        const timer = window.setInterval(refresh, 5_000);
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            cleanups.forEach((cleanup) => cleanup());
            window.clearInterval(timer);
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [loadRoom, observeRoom, observedRooms, subscribeRoomHints]);

    useEffect(() => {
        for (const [id, request] of queued.current) {
            if (!inFlight.current.has(id)) {
                queued.current.delete(id);
                void loadRoom(id, request.view, request.cursor);
            }
        }
    }, [loadRoom, states]);

    useEffect(() => {
        if (currentRoomId === undefined) return;
        setStates((current) => {
            const next = new Map(current);
            const state =
                next.get(currentRoomId) ?? createRoomThreadNavigationState();
            next.set(currentRoomId, setRoomExpanded(state, true));
            return next;
        });
    }, [currentRoomId]);

    useEffect(() => {
        for (const room of rooms) {
            const state = states.get(room.id);
            if (state?.expanded && state.status === "idle") {
                void loadRoom(room.id, state.view);
            }
        }
    }, [loadRoom, rooms, states]);

    function toggleRoom(roomId: string) {
        const state = getState(roomId);
        const expanded = !state.expanded;
        setStates((current) => {
            const next = new Map(current);
            next.set(roomId, setRoomExpanded(state, expanded));
            return next;
        });
        if (expanded && state.status === "idle")
            void loadRoom(roomId, state.view);
    }

    async function selectThread(roomId: string, threadId: string) {
        const room = rooms.find((candidate) => candidate.id === roomId);
        if (room === undefined || typeof window === "undefined") return;
        const url = roomHref(room.id, room.slug, threadId);
        if (roomId === currentRoomId) {
            selectSessionThread(roomId, threadId);
            window.history.pushState(null, "", url);
        } else {
            const result = await markRoomVisited(roomId);
            if (!result.success) return;
            selectSessionThread(roomId, threadId);
            router.push(url);
        }
        onNavigate?.();
    }

    async function createThread(roomId: string) {
        const room = rooms.find((candidate) => candidate.id === roomId);
        if (room === undefined || typeof window === "undefined") return;

        const roomUrl = roomHref(room.id, room.slug);
        if (roomId !== currentRoomId) {
            const result = await markRoomVisited(roomId);
            if (!result.success) return;
        }

        const localThreadId = crypto.randomUUID();
        registry.hydrate(roomId, localThreadId, {
            messages: [],
            durable: false,
        });
        registry.select(roomId, localThreadId);
        if (roomId === currentRoomId) {
            reconciler.clearSelection();
            window.history.pushState(
                { roomThreadSelection: localThreadId },
                "",
                roomUrl,
            );
        } else {
            router.push(roomUrl);
        }
        onNavigate?.();
    }

    async function updateThread(
        roomId: string,
        threadId: string,
        action: UpdateThreadRequest,
    ) {
        try {
            const response = await fetch(
                `/api/rooms/${roomId}/threads/${threadId}`,
                {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(action),
                },
            );
            const body = (await response.json()) as {
                thread?: ThreadSummary;
                code?: string;
                error?: string;
            };
            if (!response.ok)
                throw new Error(threadMutationError(response.status, body));
            if (body.thread === undefined) return false;
            await reconciler.refresh(roomId, threadId);
            setStates((current) => {
                const next = new Map(current);
                const state =
                    next.get(roomId) ?? createRoomThreadNavigationState();
                if (action.action === "archive" && state.view === "normal") {
                    const withRetainedSelection =
                        registry.selected(roomId) === threadId
                            ? retainSelectedSummary(state, threadId)
                            : state;
                    next.set(
                        roomId,
                        removeThreadFromNormalList(
                            withRetainedSelection,
                            threadId,
                        ),
                    );
                } else if (
                    action.action === "restore" &&
                    state.view === "archived"
                ) {
                    next.set(roomId, {
                        ...state,
                        summaries: state.summaries.filter(
                            (candidate) => candidate.id !== threadId,
                        ),
                    });
                } else {
                    next.set(
                        roomId,
                        applyThreadPage(state, {
                            threads: [body.thread!],
                            nextCursor: state.nextCursor,
                        }),
                    );
                }
                return next;
            });
            return true;
        } catch (error) {
            throw error instanceof Error
                ? error
                : new Error("Could not update this thread. Try again.");
        }
    }

    return (
        <SidebarMenu aria-label="Rooms and threads">
            {rooms.map((room) => {
                const state = getState(room.id);
                const selectedId =
                    (currentRoomId === room.id
                        ? explicitThreadId
                        : undefined) ?? registry.selected(room.id);
                const rows = visibleThreadSummaries(state);
                return (
                    <SidebarMenuItem key={room.id}>
                        <div className="flex items-center gap-1">
                            <Button
                                size="icon-xs"
                                variant="ghost"
                                type="button"
                                aria-label={`${state.expanded ? "Collapse" : "Expand"} ${room.name}`}
                                aria-expanded={state.expanded}
                                onClick={() => toggleRoom(room.id)}
                            >
                                {state.expanded ? (
                                    <ChevronDown />
                                ) : (
                                    <ChevronRight />
                                )}
                            </Button>
                            <SidebarMenuButton
                                render={
                                    <JoinRoomLink
                                        roomId={room.id}
                                        roomSlug={room.slug}
                                        onNavigate={onNavigate}
                                    >
                                        {room.name}
                                    </JoinRoomLink>
                                }
                                isActive={currentRoomId === room.id}
                            />
                            <Button
                                size="icon-xs"
                                variant="ghost"
                                type="button"
                                aria-label={`New thread in ${room.name}`}
                                onClick={() => void createThread(room.id)}
                            >
                                <Plus />
                            </Button>
                        </div>
                        {state.expanded && (
                            <SidebarMenuSub>
                                {state.status === "loading" &&
                                    rows.length === 0 && (
                                        <li
                                            className="px-2 py-2 text-xs text-muted-foreground"
                                            aria-live="polite"
                                        >
                                            Loading threads…
                                        </li>
                                    )}
                                {state.error !== null && rows.length === 0 && (
                                    <li
                                        className="px-2 py-2 text-xs text-destructive"
                                        role="alert"
                                    >
                                        {state.error ??
                                            "Could not load threads."}{" "}
                                        <button
                                            className="underline"
                                            type="button"
                                            onClick={() =>
                                                void loadRoom(
                                                    room.id,
                                                    state.view,
                                                )
                                            }
                                        >
                                            Retry
                                        </button>
                                    </li>
                                )}
                                {state.error !== null && rows.length > 0 && (
                                    <li
                                        className="px-2 py-1 text-[10px] text-destructive"
                                        role="alert"
                                    >
                                        {state.error ?? "Refresh failed."}{" "}
                                        <button
                                            className="underline"
                                            type="button"
                                            onClick={() =>
                                                void loadRoom(
                                                    room.id,
                                                    state.view,
                                                )
                                            }
                                        >
                                            Retry
                                        </button>
                                    </li>
                                )}
                                {state.status === "ready" &&
                                    rows.length === 0 && (
                                        <li className="px-2 py-2 text-xs text-muted-foreground">
                                            {state.view === "normal"
                                                ? "No threads yet. Start a fresh thread."
                                                : "No archived threads."}
                                        </li>
                                    )}
                                {rows.map((summary) => (
                                    <ThreadRow
                                        key={summary.id}
                                        summary={summary}
                                        selected={summary.id === selectedId}
                                        onSelect={() =>
                                            selectThread(room.id, summary.id)
                                        }
                                        onUpdate={(action) =>
                                            updateThread(
                                                room.id,
                                                summary.id,
                                                action,
                                            )
                                        }
                                    />
                                ))}
                                {state.view === "normal" &&
                                    selectedId !== undefined &&
                                    registry.get(room.id, selectedId)?.state
                                        .retired && (
                                        <li className="px-2 py-2 text-xs">
                                            Selected thread is archived. Its
                                            history remains readable.{" "}
                                            <button
                                                type="button"
                                                className="underline"
                                                onClick={() => {
                                                    void updateThread(
                                                        room.id,
                                                        selectedId,
                                                        {
                                                            action: "restore",
                                                        },
                                                    )
                                                        .then(() =>
                                                            loadRoom(
                                                                room.id,
                                                                state.view,
                                                            ),
                                                        )
                                                        .catch(
                                                            (error: Error) => {
                                                                setStates(
                                                                    (
                                                                        current,
                                                                    ) => {
                                                                        const next =
                                                                            new Map(
                                                                                current,
                                                                            );
                                                                        next.set(
                                                                            room.id,
                                                                            {
                                                                                ...(current.get(
                                                                                    room.id,
                                                                                ) ??
                                                                                    createRoomThreadNavigationState()),
                                                                                error: error.message,
                                                                            },
                                                                        );
                                                                        return next;
                                                                    },
                                                                );
                                                            },
                                                        );
                                                }}
                                            >
                                                Restore selected thread
                                            </button>
                                        </li>
                                    )}
                                <li className="flex items-center gap-1 px-2 py-1">
                                    <button
                                        className="text-xs text-muted-foreground hover:text-foreground"
                                        type="button"
                                        onClick={() =>
                                            void createThread(room.id)
                                        }
                                    >
                                        + New Thread
                                    </button>
                                    <button
                                        className="ml-auto text-[10px] text-muted-foreground underline"
                                        type="button"
                                        disabled={state.status === "loading"}
                                        onClick={() => {
                                            const nextView =
                                                state.view === "normal"
                                                    ? "archived"
                                                    : "normal";
                                            void loadRoom(room.id, nextView);
                                        }}
                                    >
                                        {state.view === "normal"
                                            ? "Archived"
                                            : "Current"}
                                    </button>
                                </li>
                                {state.nextCursor !== null && (
                                    <li className="px-2 py-1">
                                        <button
                                            className="text-xs underline"
                                            type="button"
                                            onClick={() =>
                                                void loadRoom(
                                                    room.id,
                                                    state.view,
                                                    state.nextCursor!,
                                                )
                                            }
                                        >
                                            Load more
                                        </button>
                                    </li>
                                )}
                            </SidebarMenuSub>
                        )}
                    </SidebarMenuItem>
                );
            })}
            {rooms.length === 0 && (
                <li className="px-2 py-2 text-xs text-muted-foreground">
                    No rooms yet.
                </li>
            )}
        </SidebarMenu>
    );
}

export default RoomThreadNavigation;
