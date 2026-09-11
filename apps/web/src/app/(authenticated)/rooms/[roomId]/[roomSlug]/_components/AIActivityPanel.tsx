"use client";

import { BoxColumn, BoxRow, Button, Spinner, TextBox } from "@/components/ui";
import ContextWindowBar from "@/features/runs/components/ContextWindowBar";
import RunConversation from "@/features/runs/components/RunConversation";
import { useRoomRun } from "@/features/runs/hooks/useRoomRun";
import { runLockEnabled } from "@/features/runs/lock/runLockConfig";
import ThreadComposer from "@/features/threads/components/ThreadComposer/ThreadComposer";
import ThreadWelcome from "@/features/threads/components/ThreadWelcome/ThreadWelcome";
import type {
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";

interface Props {
    roomId: string;
    currentUser: RunMessageAuthor;
    initialThreadId: string;
    initialMessages?: Array<RunUIMessage>;
    initialStatus?: RunStatus;
    initialRunBy?: RunMessageAuthor | null;
    initialSeq?: number;
    initialThreadDurable?: boolean;
}

function AIActivityPanel({
    roomId,
    currentUser,
    initialThreadId,
    initialMessages,
    initialStatus,
    initialRunBy,
    initialSeq,
    initialThreadDurable,
}: Props) {
    const {
        activeThreadId,
        messages,
        startRun,
        newThread,
        stop,
        status,
        threadStatus,
        runBy,
        threadRetired,
        isConnected,
        notice,
        dismissNotice,
        model,
        setModel,
        draft,
        draftRevision,
        setDraft,
        clearAcceptedDraft,
        loadState,
        historyError,
        retryHistory,
    } = useRoomRun({
        roomId,
        currentUser,
        initialThreadId,
        initialMessages,
        initialStatus,
        initialRunBy,
        initialSeq,
        initialThreadDurable,
    });

    const streamingHere = status === "submitted" || status === "streaming";
    const otherRunner =
        runBy !== null && runBy.id !== currentUser.id ? runBy : null;
    // The composer only yields to another member's run while the lock is on.
    const composerLocked =
        streamingHere || (runLockEnabled && threadStatus === "running");

    return (
        <BoxColumn className="h-full min-h-0 p-2">
            <div className="flex shrink-0 items-center justify-between gap-2">
                <TextBox>Agent Orchestrator Thread</TextBox>
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void newThread()}
                    >
                        New Thread
                    </Button>
                </div>
            </div>
            {threadRetired && (
                <TextBox className="m-2 shrink-0 text-xs text-white/40">
                    This thread was retired. Its history is kept.
                </TextBox>
            )}
            {notice !== null && messages.length > 0 && (
                <BoxRow className="mx-2 mt-2 shrink-0 items-center justify-between gap-2 rounded-lg bg-red-500/10 px-2 py-1">
                    <TextBox className="text-xs text-red-300/80">
                        {notice}
                    </TextBox>
                    <Button size="sm" variant="ghost" onClick={dismissNotice}>
                        Dismiss
                    </Button>
                </BoxRow>
            )}
            {messages.length > 0 ? (
                <RunConversation
                    messages={messages}
                    incomplete={
                        threadStatus === "failed" ||
                        threadStatus === "cancelled"
                    }
                />
            ) : loadState === "loaded" ? (
                <ThreadWelcome />
            ) : loadState === "loading" && historyError === null ? (
                <div className="flex min-h-0 flex-1 items-center justify-center">
                    <Spinner aria-label="Loading thread history" />
                </div>
            ) : (
                <div
                    className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-destructive"
                    role="alert"
                >
                    Thread history could not be loaded. Use Retry below.
                </div>
            )}
            <ContextWindowBar messages={messages} model={model} />
            {threadStatus === "running" && otherRunner !== null && (
                <TextBox className="mx-2 mt-1 text-[10px] text-white/40">
                    {otherRunner.name} is running the agent.
                </TextBox>
            )}
            {!isConnected && (
                <TextBox className="mx-2 mt-1 text-[10px] text-white/30">
                    Reconnecting — other members&apos; turns may be delayed.
                </TextBox>
            )}
            <ThreadComposer
                className="m-2 mt-2 shrink-0"
                targetKey={`${roomId}:${activeThreadId}`}
                revision={draftRevision}
                placeholder={
                    composerLocked && otherRunner !== null
                        ? `${otherRunner.name} is running the agent`
                        : "What should the agent do?"
                }
                disabled={
                    composerLocked ||
                    status !== "ready" ||
                    threadRetired ||
                    loadState !== "loaded"
                }
                busy={composerLocked}
                value={draft}
                model={model}
                onValueChange={setDraft}
                onModelChange={setModel}
                onAccepted={(revision, result) =>
                    clearAcceptedDraft(
                        result?.targetKey ?? `${roomId}:${activeThreadId}`,
                        revision,
                    )
                }
                onSubmit={async (text) => {
                    const acceptedThreadId = await startRun(text);
                    return {
                        accepted: true,
                        targetKey: `${roomId}:${acceptedThreadId}`,
                    };
                }}
                controls={
                    streamingHere ? (
                        <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            onClick={() => stop()}
                        >
                            Stop
                        </Button>
                    ) : undefined
                }
                error={messages.length === 0 ? notice : undefined}
                onRetry={
                    messages.length === 0 && historyError !== null
                        ? retryHistory
                        : undefined
                }
            />
        </BoxColumn>
    );
}
export default AIActivityPanel;
