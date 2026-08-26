import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui";
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { toRunActor } from "@/features/runs/server/runActor";
import { runRuntime } from "@/features/runs/server/runRuntime";
import { getRoomPageData } from "@/features/rooms/queries/roomPageQueries";
import { loadThread } from "@multiplayer-ai/orchestration";
import { notFound, redirect } from "next/navigation";
import AIActivityPanel from "./_components/AIActivityPanel";
import GroupChatPanel from "./_components/GroupChatPanel";
import PromptVotePanel from "./_components/PromptVotePanel";

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
    const currentUser = toRunActor(user, roomPageData.currentMembership.profile);
    const thread = await loadThread(runRuntime.store(), roomId, currentUser);

    return (
        <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-screen w-full"
        >
            <ResizablePanel
                defaultSize="27%"
                minSize="35%"
            >
                <AIActivityPanel
                    key={roomId}
                    roomId={roomId}
                    currentUser={currentUser}
                    initialThreadId={thread.threadId}
                    initialMessages={thread.messages}
                    initialStatus={thread.status}
                    initialRunBy={thread.runBy}
                    initialSeq={thread.lastSeq}
                />
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
                            currentUserIsAdmin={
                                roomPageData.currentMembership.isAdmin
                            }
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
