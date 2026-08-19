import { BoxColumn } from "@/components/ui";
import { Button } from "@/components/ui/Button";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/Empty";
import { getCurrentUser } from "@/lib/supabase/getCurrentUser";
import { createAdminClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import RoomList from "./_components/RoomList";

async function getJoinedRooms(userId: string) {
    const supabase = createAdminClient();

    const { data, error } = await supabase
        .from("room")
        .select("*, room_member (member_id)")
        .order("created_at", { ascending: true });

    if (error) {
        return [];
    }

    return data
        .filter((room) => room.room_member.some((u) => u.member_id === userId))
        .map((room) => ({
            id: room.id,
            name: room.name,
            slug: room.slug,
            created_at: room.created_at,
            memberCount: room.room_member.length,
        }));
}

async function HomePage() {
    const user = await getCurrentUser();
    if (user === null) {
        redirect("/auth/login");
    }
    const rooms = await getJoinedRooms(user.id);

    if (rooms.length === 0) {
        return (
            <main className="flex min-h-screen w-full items-center justify-center">
                <BoxColumn>
                    <Empty className="border border-dashed">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                {/* <MessageSquareIcon /> */}
                            </EmptyMedia>
                            <EmptyTitle>No Rooms</EmptyTitle>
                            <EmptyDescription>
                                Create a new room to get started
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button>
                                <Link href="/rooms/new">Create Room</Link>
                            </Button>
                        </EmptyContent>
                    </Empty>
                </BoxColumn>
            </main>
        );
    }

    return (
        <BoxColumn>
            <RoomList
                title="Your Rooms"
                rooms={rooms}
            />
            <Button>
                <Link href="/rooms/new">Create Room</Link>
            </Button>
        </BoxColumn>
    );
}

export default HomePage;
