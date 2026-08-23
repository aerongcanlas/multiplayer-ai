"use client";

import { createRoomInvite } from "@/features/rooms/actions/createRoomInvite";
import { CheckIcon, CopyIcon, UserPlusIcon } from "lucide-react";
import { useState, useTransition } from "react";
import {
    Box,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Input,
} from "./ui";

interface Props {
    roomId: string;
}

export default function InviteUserModal({ roomId }: Props) {
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    function reset() {
        setInviteUrl(null);
        setMessage(null);
    }

    function handleCreateInvite() {
        setMessage(null);

        startTransition(async () => {
            const result = await createRoomInvite({ roomId });

            if (!result.success) {
                setMessage(result.error);
                return;
            }

            setInviteUrl(
                new URL(result.invitePath, window.location.origin).toString(),
            );

            setMessage(
                "Invitation created. This invitation expires in 24 hours.",
            );
        });
    }

    async function handleCopy() {
        if (inviteUrl === null) return;

        try {
            await navigator.clipboard.writeText(inviteUrl);
            setMessage("Invite link copied.");
        } catch {
            setMessage("Copy failed. Select and copy the link manually.");
        }
    }

    return (
        <Dialog
            onOpenChange={(open) => {
                if (!open) reset();
            }}
        >
            <DialogTrigger
                render={
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                    />
                }
            >
                <UserPlusIcon />
                Invite
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Invite User</DialogTitle>
                    <DialogDescription>
                        Create a single-use link that expires in 24 hours.
                    </DialogDescription>
                </DialogHeader>

                {inviteUrl !== null && (
                    <Box className="flex gap-2">
                        <Input
                            aria-label="Invite link"
                            readOnly
                            value={inviteUrl}
                            onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleCopy}
                        >
                            {message == "Invite link copied." ? (
                                <CheckIcon />
                            ) : (
                                <CopyIcon />
                            )}
                        </Button>
                    </Box>
                )}

                <p
                    role={message?.includes("failed") ? "alert" : "status"}
                    aria-live="polite"
                    className="min-h-5 text-sm text-muted-foreground"
                >
                    {message}
                </p>

                <DialogFooter>
                    <Button
                        type="button"
                        disabled={isPending}
                        onClick={handleCreateInvite}
                    >
                        {isPending
                            ? "Creating..."
                            : inviteUrl === null
                              ? "Create invitation"
                              : "Create another"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
