import AIActivityPanel from "@/components/AIActivityPanel";
import GroupChatPanel from "@/components/GroupChatPanel";
import PromptVotePanel from "@/components/PromptVotePanel";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui";

interface Props {
    params: Promise<{ roomId: string; roomSlug: string }>;
}

async function RoomPage({ params }: Props) {
    const { roomId } = await params;

    return (
        <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-screen w-full"
        >
            <ResizablePanel
                defaultSize="27%"
                minSize="35%"
            >
                <AIActivityPanel roomId={roomId} />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
                defaultSize="55%"
                minSize="30%"
            >
                <ResizablePanelGroup orientation="vertical">
                    <ResizablePanel
                        defaultSize="70%"
                        minSize="30%"
                    >
                        <GroupChatPanel />
                    </ResizablePanel>

                    <ResizableHandle />

                    <ResizablePanel
                        defaultSize="30%"
                        minSize="15%"
                    >
                        <PromptVotePanel />
                    </ResizablePanel>
                </ResizablePanelGroup>
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
export default RoomPage;
