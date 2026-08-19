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
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import RoomList from "@/features/rooms/components/RoomList";
import { getJoinedRooms } from "@/features/rooms/queries/getJoinedRooms";
import Link from "next/link";
import { redirect } from "next/navigation";

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
