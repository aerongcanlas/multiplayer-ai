import { Box, BoxColumn, BoxRow, Button } from "@/components/ui";
import type { JoinedRoom } from "@/features/rooms/types/room";
import Link from "next/link";

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
                                <Box>
                                    <Button>
                                        <Link
                                            href={`/rooms/${room.id}/${room.slug}`}
                                        >
                                            {room.name}
                                        </Link>
                                    </Button>
                                    <BoxRow>
                                        {new Intl.DateTimeFormat("en-US", {
                                            dateStyle: "medium",
                                            timeStyle: "short",
                                        }).format(
                                            new Date(room.created_at),
                                        )}{" "}
                                        Current members: {room.memberCount}
                                    </BoxRow>
                                </Box>
                            )}
                            {variant === "short" && (
                                <Box>
                                    <Link
                                        href={`/rooms/${room.id}/${room.slug}`}
                                    >
                                        {room.name}
                                    </Link>
                                </Box>
                            )}
                        </BoxColumn>
                    );
                })}
            </BoxColumn>
        </Box>
    );
}
export default RoomList;
