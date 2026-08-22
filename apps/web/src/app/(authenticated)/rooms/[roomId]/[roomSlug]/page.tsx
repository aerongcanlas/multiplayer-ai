import AIActivityPanel from "@/components/AIActivityPanel";
import GroupChatPanel from "@/components/GroupChatPanel";
import PromptVotePanel from "@/components/PromptVotePanel";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui";
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { getRoomPageData } from "@/features/rooms/queries/roomPageQueries";
import { notFound, redirect } from "next/navigation";

interface Props {
    params: Promise<{
        roomId: string;
        roomSlug: string;
    }>;
}

async function RoomPage({ params }: Props) {
    const { roomId, roomSlug } = await params;
    const user = await getCurrentUser();
    if (user === null) {
        redirect("/auth/login");
    }

    const roomPageData = await getRoomPageData(roomId, user.id);

    if (roomPageData === null) {
        notFound();
    }

    if (roomPageData.room.slug !== roomSlug) {
        redirect(`/rooms/${roomPageData.room.id}/${roomPageData.room.slug}`);
    }

    const members = roomPageData.members;
    const messages = roomPageData.messages;

    return (
        <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-screen w-full"
        >
            <ResizablePanel
                defaultSize="27%"
                minSize="35%"
            >
                <AIActivityPanel />
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
                        <GroupChatPanel
                            key={roomId}
                            roomId={roomId}
                            roomName={roomPageData.room.name}
                            currentUserId={user.id}
                            initialMessages={messages}
                            members={members}
                        />
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
