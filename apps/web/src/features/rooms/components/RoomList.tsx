import {
    Box,
    BoxColumn,
    Card,
    CardAction,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui";
import { buttonVariants } from "@/components/ui/Button";
import { JoinRoomLink } from "@/features/rooms/components/JoinRoomLink";
import RoomThreadNavigation from "@/features/threads/components/RoomThreadNavigation/RoomThreadNavigation";
import type { JoinedRoom } from "@/features/rooms/types/room";

interface Props {
    title: string;
    rooms: JoinedRoom[];
    variant: "short" | "full";
    onNavigate?: () => void;
}

function RoomList({ title, rooms, variant = "short", onNavigate }: Props) {
    return (
        <Box className="m-2">
            {variant === "full" && <p>{title}</p>}
            {variant === "short" && (
                <RoomThreadNavigation
                    key={rooms.map(({ id }) => id).join(":")}
                    rooms={rooms}
                    onNavigate={onNavigate}
                />
            )}
            {variant === "full" && (
                <BoxColumn>
                    {rooms.map((room) => {
                        return (
                            <BoxColumn key={room.id} className="py-1">
                                <Card>
                                    <CardHeader>
                                        <CardTitle>{room.name}</CardTitle>

                                        <CardDescription>
                                            Current members: {room.member_count}
                                            {" | "}
                                            Last visited at:{" "}
                                            {new Intl.DateTimeFormat("en-US", {
                                                dateStyle: "medium",
                                                timeStyle: "short",
                                            }).format(
                                                new Date(room.last_visited_at),
                                            )}
                                            {" | "}
                                            Created at:{" "}
                                            {new Intl.DateTimeFormat("en-US", {
                                                dateStyle: "medium",
                                                timeStyle: "short",
                                            }).format(
                                                new Date(room.created_at),
                                            )}
                                        </CardDescription>

                                        <CardAction className="self-center">
                                            <JoinRoomLink
                                                roomId={room.id}
                                                roomSlug={room.slug}
                                                className={buttonVariants()}
                                            >
                                                Join Room
                                            </JoinRoomLink>
                                        </CardAction>
                                    </CardHeader>
                                </Card>
                            </BoxColumn>
                        );
                    })}
                </BoxColumn>
            )}
        </Box>
    );
}
export default RoomList;
