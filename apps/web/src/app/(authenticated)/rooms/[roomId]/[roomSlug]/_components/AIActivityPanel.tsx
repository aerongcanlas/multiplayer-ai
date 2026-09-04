"use client";

import { BoxColumn, BoxRow, Button, TextBox } from "@/components/ui";
import ContextWindowBar from "@/features/runs/components/ContextWindowBar";
import RunConversation from "@/features/runs/components/RunConversation";
import RunModelSwitcher from "@/features/runs/components/RunModelSwitcher";
import { useRoomRun } from "@/features/runs/hooks/useRoomRun";
import { runLockEnabled } from "@/features/runs/lock/runLockConfig";
import type {
    RunMessageAuthor,
    RunStatus,
    RunUIMessage,
} from "@multiplayer-ai/domain";
import PromptInput from "./PromptInput";
import { usePromptSuggestions } from "./PromptSuggestionProvider";

interface Props {
    roomId: string;
    currentUser: RunMessageAuthor;
    initialThreadId: string;
    initialMessages?: Array<RunUIMessage>;
    initialStatus?: RunStatus;
    initialRunBy?: RunMessageAuthor | null;
    initialSeq?: number;
}

function AIActivityPanel({
    roomId,
    currentUser,
    initialThreadId,
    initialMessages,
    initialStatus,
    initialRunBy,
    initialSeq,
}: Props) {
    const { draftPrompt, setDraftPrompt } = usePromptSuggestions();
    const {
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
    } = useRoomRun({
        roomId,
        currentUser,
        initialThreadId,
        initialMessages,
        initialStatus,
        initialRunBy,
        initialSeq,
    });

    const streamingHere = status === "submitted" || status === "streaming";
    const otherRunner =
        runBy !== null && runBy.id !== currentUser.id ? runBy : null;
    // New Thread is refused mid-run in both modes, so it tracks the run, not the policy.
    const runInFlight = streamingHere || threadStatus === "running";
    // The composer only yields to another member's run while the lock is on.
    const composerLocked =
        streamingHere || (runLockEnabled && threadStatus === "running");

    return (
        <BoxColumn className="h-full min-h-0 p-2">
            <div className="flex shrink-0 items-center justify-between gap-2">
                <TextBox>Agent Orchestrator Thread</TextBox>
                <div className="flex items-center gap-2">
                    {streamingHere && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => stop()}
                        >
                            Stop
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void newThread()}
                        disabled={runInFlight}
                    >
                        New Thread
                    </Button>
                    <RunModelSwitcher
                        value={model}
                        onChange={setModel}
                    />
                </div>
            </div>
            {threadRetired && (
                <TextBox className="m-2 shrink-0 text-xs text-white/40">
                    This thread was retired. Its history is kept.
                </TextBox>
            )}
            {notice !== null && (
                <BoxRow className="mx-2 mt-2 shrink-0 items-center justify-between gap-2 rounded-lg bg-red-500/10 px-2 py-1">
                    <TextBox className="text-xs text-red-300/80">
                        {notice}
                    </TextBox>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={dismissNotice}
                    >
                        Dismiss
                    </Button>
                </BoxRow>
            )}
            <RunConversation
                messages={messages}
                incomplete={
                    threadStatus === "failed" || threadStatus === "cancelled"
                }
            />
            <ContextWindowBar
                messages={messages}
                model={model}
            />
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
            <PromptInput
                className="m-2 mt-2 h-20 shrink-0 rounded-2xl"
                placeholder={
                    composerLocked && otherRunner !== null
                        ? `${otherRunner.name} is running the agent`
                        : "What should the agent do?"
                }
                disabled={composerLocked || status !== "ready"}
                value={draftPrompt}
                onValueChange={setDraftPrompt}
                onSubmit={(text) => startRun(text)}
            />
        </BoxColumn>
    );
}
export default AIActivityPanel;
