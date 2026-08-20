import {
    Box,
    BoxColumn,
    Card,
    CardAction,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui";
import type { JoinedRoom } from "@/features/rooms/types/room";
import Link from "next/link";
import { buttonVariants } from "./ui/Button";

interface Props {
    title: string;
    rooms: JoinedRoom[];
    variant: "short" | "full";
}

function RoomList({ title, rooms, variant = "short" }: Props) {
    return (
        <Box className="m-2">
            {variant === "full" && <p>{title}</p>}
            <BoxColumn>
                {rooms.map((room) => {
                    return (
                        <BoxColumn
                            key={room.id}
                            className="py-1"
                        >
                            {variant === "full" && (
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
                                            <Link
                                                href={`/rooms/${room.id}/${room.slug}`}
                                                className={buttonVariants()}
                                            >
                                                Join Room
                                            </Link>
                                        </CardAction>
                                    </CardHeader>
                                </Card>
                            )}
                            {variant === "short" && (
                                <Card>
                                    <CardHeader>
                                        <Link
                                            href={`/rooms/${room.id}/${room.slug}`}
                                        >
                                            {room.name}
                                        </Link>
                                    </CardHeader>
                                </Card>
                            )}
                        </BoxColumn>
                    );
                })}
            </BoxColumn>
        </Box>
    );
}
export default RoomList;
