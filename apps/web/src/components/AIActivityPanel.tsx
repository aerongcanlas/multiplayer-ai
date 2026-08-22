"use client";

import { BoxColumn, Button, TextBox } from "@/components/ui";
import RunConversation from "@/features/runs/components/RunConversation";
import RunModelSwitcher from "@/features/runs/components/RunModelSwitcher";
import { useRoomRun } from "@/features/runs/hooks/useRoomRun";
import TextEntryBubble from "./TextEntryBubble";

interface Props {
    roomId: string;
}

function AIActivityPanel({ roomId }: Props) {
    const { messages, startRun, stop, status, model, setModel } = useRoomRun(roomId);
    const running = status === "submitted" || status === "streaming";

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
                    <RunModelSwitcher
                        value={model}
                        onChange={setModel}
                    />
                </div>
            </div>
            <RunConversation messages={messages} />
            <TextEntryBubble
                className="m-2 mt-2 rounded-2xl shrink-0 h-20"
                placeholder="What should the agent do?"
                disabled={status !== "ready"}
                onSubmit={(text) => startRun(text)}
            />
        </BoxColumn>
    );
}
export default AIActivityPanel;
