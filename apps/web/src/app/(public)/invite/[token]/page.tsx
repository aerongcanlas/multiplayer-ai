import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from "@/components/ui";
import { acceptRoomInvite } from "@/features/rooms/actions/acceptRoomInvite";
import { getRoomInvitePreview } from "@/features/rooms/queries/getRoomInvitePreview";
import { acceptRoomInviteSchema } from "@multiplayer-ai/domain";
import { notFound } from "next/navigation";

interface Props {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ error?: string | string[] }>;
}

export default async function RoomInvitePage({ params, searchParams }: Props) {
    const { token } = await params;
    const parsed = acceptRoomInviteSchema.safeParse({ token });

    if (!parsed.success) {
        notFound();
    }

    const [invite, query] = await Promise.all([
        getRoomInvitePreview(parsed.data.token),
        searchParams,
    ]);

    if (invite === null) {
        return (
            <main className="flex min-h-svh items-center justify-center p-6">
                <Card className="w-full max-w-sm">
                    <CardHeader>
                        <CardTitle>Invite unavailable</CardTitle>
                    </CardHeader>
                    <CardContent>
                        This link expired, was revoked, or has already been
                        used.
                    </CardContent>
                </Card>
            </main>
        );
    }

    const error = typeof query.error === "string" ? query.error : null;
    const acceptAction = acceptRoomInvite.bind(null, {
        token: parsed.data.token,
    });

    return (
        <main className="flex min-h-svh items-center justify-center p-6">
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>Join {invite.name}</CardTitle>
                </CardHeader>
                <CardContent>
                    <form
                        action={acceptAction}
                        className="flex flex-col gap-4"
                    >
                        <p className="text-sm text-muted-foreground">
                            This invitation can be used once and expires after
                            24 hours.
                        </p>

                        {error !== null && (
                            <p
                                role="alert"
                                className="text-sm text-destructive"
                            >
                                {error === "server"
                                    ? "Could not accept the invitation. Try again."
                                    : "This invitation is no longer valid."}
                            </p>
                        )}

                        <Button type="submit">Accept invitation</Button>
                    </form>
                </CardContent>
            </Card>
        </main>
    );
}
