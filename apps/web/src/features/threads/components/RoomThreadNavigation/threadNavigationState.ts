import type { ThreadPage, ThreadSummary } from "@multiplayer-ai/domain";

export type ThreadNavigationView = "normal" | "archived";
export type ThreadListStatus = "idle" | "loading" | "ready" | "error";

export type RoomThreadNavigationState = {
    view: ThreadNavigationView;
    expanded: boolean;
    status: ThreadListStatus;
    summaries: ThreadSummary[];
    nextCursor: string | null;
    error: string | null;
    /** A selected row is retained while a remote archive removes it from normal results. */
    retainedSelection: ThreadSummary | null;
};

export type SelectionResolution =
    | { kind: "selected"; threadId: string }
    | { kind: "fresh"; threadId: null }
    | { kind: "denied"; threadId: string };

export function createRoomThreadNavigationState(
    view: ThreadNavigationView = "normal",
): RoomThreadNavigationState {
    return {
        view,
        expanded: false,
        status: "idle",
        summaries: [],
        nextCursor: null,
        error: null,
        retainedSelection: null,
    };
}

/** Begin a request without making an initial failure look like an empty room. */
export function beginThreadPageLoad(
    state: RoomThreadNavigationState,
): RoomThreadNavigationState {
    return {
        ...state,
        status: "loading",
        error: null,
    };
}

/** Canonical API pages are authoritative; merge by identity for stable pagination. */
export function applyThreadPage(
    state: RoomThreadNavigationState,
    page: ThreadPage,
): RoomThreadNavigationState {
    const byId = new Map(
        state.summaries.map((summary) => [summary.id, summary]),
    );
    for (const summary of page.threads) byId.set(summary.id, summary);
    const summaries = [...byId.values()].sort(compareThreads);
    const retainedSelection = state.retainedSelection;
    return {
        ...state,
        status: "ready",
        summaries,
        nextCursor: page.nextCursor,
        error: null,
        retainedSelection:
            retainedSelection !== null &&
            summaries.some((summary) => summary.id === retainedSelection.id)
                ? null
                : retainedSelection,
    };
}

/** Replace a refresh result; unlike pagination, stale rows are no longer canonical. */
export function replaceThreadPage(
    state: RoomThreadNavigationState,
    page: ThreadPage,
): RoomThreadNavigationState {
    return applyThreadPage(
        { ...state, summaries: [], retainedSelection: state.retainedSelection },
        page,
    );
}

/** Preserve known rows for recoverable refresh errors, including the selection. */
export function failThreadPageLoad(
    state: RoomThreadNavigationState,
    error: string,
    status?: number,
): RoomThreadNavigationState {
    if (status === 401 || status === 403 || status === 404) {
        return {
            ...state,
            status: "error",
            summaries: [],
            nextCursor: null,
            error,
            retainedSelection: null,
        };
    }
    return { ...state, status: "error", error };
}

export function setThreadNavigationView(
    state: RoomThreadNavigationState,
    view: ThreadNavigationView,
): RoomThreadNavigationState {
    return {
        ...state,
        view,
        status: "idle",
        summaries: [],
        nextCursor: null,
        error: null,
        retainedSelection: null,
    };
}

export function setRoomExpanded(
    state: RoomThreadNavigationState,
    expanded: boolean,
): RoomThreadNavigationState {
    return { ...state, expanded };
}

export function retainSelectedSummary(
    state: RoomThreadNavigationState,
    threadId: string,
): RoomThreadNavigationState {
    const selected = state.summaries.find((summary) => summary.id === threadId);
    return selected === undefined
        ? state
        : { ...state, retainedSelection: selected };
}

export function removeThreadFromNormalList(
    state: RoomThreadNavigationState,
    threadId: string,
): RoomThreadNavigationState {
    const selected =
        state.retainedSelection?.id === threadId
            ? state.retainedSelection
            : undefined;
    return {
        ...state,
        summaries: state.summaries.filter((summary) => summary.id !== threadId),
        retainedSelection:
            selected === undefined
                ? state.retainedSelection
                : { ...selected, retiredAt: new Date().toISOString() },
    };
}

export function visibleThreadSummaries(
    state: RoomThreadNavigationState,
): ThreadSummary[] {
    const summaries = [...state.summaries];
    if (
        state.view === "normal" &&
        state.retainedSelection !== null &&
        !summaries.some((summary) => summary.id === state.retainedSelection?.id)
    ) {
        summaries.push(state.retainedSelection);
    }
    return summaries.sort(compareThreads);
}

/**
 * Resolve URL selection before personal memory and newest normal thread.
 * When authorizedIds is supplied, an explicit unknown ID is denied rather
 * than silently falling back to another conversation.
 */
export function resolveThreadSelection(input: {
    explicitThreadId?: string;
    lastSelectedThreadId?: string;
    normalThreads: ThreadSummary[];
    authorizedIds?: ReadonlySet<string>;
    freshThreadId?: string | null;
}): SelectionResolution {
    if (input.explicitThreadId !== undefined) {
        if (
            input.authorizedIds !== undefined &&
            !input.authorizedIds.has(input.explicitThreadId)
        ) {
            return { kind: "denied", threadId: input.explicitThreadId };
        }
        return { kind: "selected", threadId: input.explicitThreadId };
    }

    if (input.lastSelectedThreadId !== undefined) {
        return { kind: "selected", threadId: input.lastSelectedThreadId };
    }
    const newest = [...input.normalThreads].sort(compareThreads)[0];
    if (newest !== undefined) {
        return { kind: "selected", threadId: newest.id };
    }
    return { kind: "fresh", threadId: null };
}

export function selectionAfterCreation(
    current: string | undefined,
    created: string,
    initiatingBrowser: boolean,
) {
    return initiatingBrowser ? created : current;
}

export function selectionFromLocation(location: string, roomId: string) {
    const url = new URL(location, "https://local.invalid");
    return url.pathname.split("/")[2] === roomId
        ? (url.searchParams.get("thread") ?? undefined)
        : undefined;
}

export function threadMutationError(
    status: number,
    body: { code?: string; error?: string },
) {
    return status === 409 && body.code === "busy"
        ? "This thread is busy. Stop or wait for the run to finish."
        : (body.error ?? "Could not update this thread. Try again.");
}

export function isKnownThreadId(
    states: Iterable<RoomThreadNavigationState>,
    threadId: string,
): boolean {
    for (const state of states) {
        if (state.summaries.some((summary) => summary.id === threadId)) {
            return true;
        }
        if (state.retainedSelection?.id === threadId) return true;
    }
    return false;
}

function compareThreads(left: ThreadSummary, right: ThreadSummary) {
    const byCreated = right.createdAt.localeCompare(left.createdAt);
    return byCreated !== 0 ? byCreated : right.id.localeCompare(left.id);
}
