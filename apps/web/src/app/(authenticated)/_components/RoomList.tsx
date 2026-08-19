import { Box, BoxColumn, BoxRow, Button } from "@/components/ui";
import type { Database } from "@/types/database.types";
import Link from "next/link";

interface Props {
    title: string;
    rooms: (Database["public"]["Tables"]["room"]["Row"] & {
        memberCount: number;
    })[];
}

function RoomList({ title, rooms }: Props) {
    return (
        <Box>
            <p>{title}</p>
            <BoxColumn>
                {rooms.map((room) => {
                    return (
                        <BoxColumn key={room.id}>
                            <Button>
                                <Link href={`/rooms/${room.id}/${room.slug}`}>
                                    {room.name}
                                </Link>
                            </Button>
                            <BoxRow>
                                {new Intl.DateTimeFormat("en-US", {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                }).format(new Date(room.created_at))}{" "}
                                Current members: {room.memberCount}
                            </BoxRow>
                        </BoxColumn>
                    );
                })}
            </BoxColumn>
        </Box>
    );
}
export default RoomList;
