import { Box } from "@/components/ui";
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { RoomWorkspace } from "@/features/rooms/components/RoomWorkspace/RoomWorkspace";
import { getRoomPageData } from "@/features/rooms/queries/roomPageQueries";
import { toRunActor } from "@/features/runs/server/runActor";
import { runRuntime } from "@/features/runs/server/runRuntime";
import { createThreadService } from "@/features/threads/server/threadService";
import { loadThread } from "@multiplayer-ai/orchestration";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import AIActivityPanel from "./_components/AIActivityPanel";
import GroupChatPanel from "./_components/GroupChatPanel";
import InviteUserModal from "./_components/InviteUserModal";
import { PromptSuggestionProvider } from "./_components/PromptSuggestionProvider";
import PromptVotePanel from "./_components/PromptVotePanel";

interface Props {
    params: Promise<{
        roomId: string;
        roomSlug: string;
    }>;
    searchParams?: Promise<{ thread?: string }>;
}

async function RoomPage({ params, searchParams }: Props) {
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
    const currentUser = toRunActor(
        user,
        roomPageData.currentMembership.profile,
    );
    const requestedThreadId = (await searchParams)?.thread;
    if (
        requestedThreadId !== undefined &&
        !z.uuid().safeParse(requestedThreadId).success
    ) {
        notFound();
    }
    const selectedThreadId =
        requestedThreadId ??
        (
            await createThreadService().list({
                roomId,
                actorId: currentUser.id,
                limit: 1,
            })
        ).threads[0]?.id;
    const thread =
        selectedThreadId === undefined
            ? {
                  threadId: crypto.randomUUID(),
                  status: "finished" as const,
                  runBy: null,
                  messages: [],
                  lastSeq: 0,
                  retired: false,
              }
            : await loadThread(
                  runRuntime.store(),
                  roomId,
                  selectedThreadId,
                  currentUser,
              ).catch((error: unknown) => {
                  if (
                      error instanceof Error &&
                      error.message === "Thread not found"
                  ) {
                      notFound();
                  }
                  throw error;
              });

    return (
        <PromptSuggestionProvider>
            <RoomWorkspace
                header={
                    <Box className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-3 border-b px-4 py-2 max-md:pl-14">
                        <Box className="col-start-2 min-w-0 truncate text-lg font-semibold">
                            {roomPageData.room.name}
                        </Box>
                        {roomPageData.currentMembership.isAdmin && (
                            <Box className="col-start-3 justify-self-end">
                                <InviteUserModal roomId={roomId} />
                            </Box>
                        )}
                    </Box>
                }
                aiPanel={
                    <AIActivityPanel
                        key={roomId}
                        roomId={roomId}
                        currentUser={currentUser}
                        initialThreadId={thread.threadId}
                        initialMessages={thread.messages}
                        initialStatus={thread.status}
                        initialRunBy={thread.runBy}
                        initialSeq={thread.lastSeq}
                        initialThreadDurable={selectedThreadId !== undefined}
                        initialThreadRetired={thread.retired}
                    />
                }
                memberChatPanel={
                    <GroupChatPanel
                        key={roomId}
                        roomId={roomId}
                        currentUserId={user.id}
                        initialMessages={messages}
                        members={members}
                    />
                }
                promptPanel={<PromptVotePanel />}
            />
        </PromptSuggestionProvider>
    );
}
export default RoomPage;
