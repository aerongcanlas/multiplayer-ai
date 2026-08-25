"use client";

import type { RunStatus } from "@multiplayer-ai/domain";
import { BoxColumn, Button, TextBox } from "@/components/ui";
import ContextWindowBar from "@/features/runs/components/ContextWindowBar";
import RunConversation from "@/features/runs/components/RunConversation";
import RunModelSwitcher from "@/features/runs/components/RunModelSwitcher";
import { useRoomRun } from "@/features/runs/hooks/useRoomRun";
import type { RunUIMessage } from "@/features/runs/types/runMessage";
import { useState } from "react";
import PromptInput from "./PromptInput";

interface Props {
    roomId: string;
    initialMessages?: Array<RunUIMessage>;
    initialStatus?: RunStatus;
}

function AIActivityPanel({ roomId, initialMessages, initialStatus }: Props) {
    const { messages, startRun, newThread, stop, status, model, setModel } =
        useRoomRun({ roomId, initialMessages });
    const [threadStatus, setThreadStatus] = useState<RunStatus>(
        initialStatus ?? "finished",
    );
    const running = status === "submitted" || status === "streaming";

    function handleStartRun(text: string) {
        setThreadStatus("finished");
        return startRun(text);
    }

    async function handleNewThread() {
        await newThread();
        setThreadStatus("finished");
    }

    return (
        <BoxColumn className="h-full min-h-0 p-2">
            <div className="flex shrink-0 items-center justify-between gap-2">
                <TextBox>AIActivityPanel</TextBox>
                <div className="flex items-center gap-2">
                    {running && (
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
                        onClick={handleNewThread}
                        disabled={running}
                    >
                        New Thread
                    </Button>
                    <RunModelSwitcher
                        value={model}
                        onChange={setModel}
                    />
                </div>
            </div>
            <RunConversation
                messages={messages}
                incomplete={threadStatus !== "finished"}
            />
            <ContextWindowBar
                messages={messages}
                model={model}
            />
            <PromptInput
                className="m-2 mt-2 rounded-2xl shrink-0 h-20"
                placeholder="What should the agent do?"
                disabled={status !== "ready"}
                onSubmit={(text) => handleStartRun(text)}
            />
        </BoxColumn>
    );
}
export default AIActivityPanel;
