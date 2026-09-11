"use client";

import { toast } from "@/components/ui/Toast";
import { markRoomVisited } from "@/features/rooms/actions/markRoomVisited";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useTransition } from "react";

type JoinRoomLinkProps = {
    roomId: string;
    roomSlug: string;
    children: ReactNode;
    className?: string;
    threadId?: string;
    onNavigate?: () => void;
};

export function JoinRoomLink({
    roomId,
    roomSlug,
    children,
    className,
    threadId,
    onNavigate,
}: JoinRoomLinkProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const href = `/rooms/${roomId}/${roomSlug}${threadId === undefined ? "" : `?thread=${encodeURIComponent(threadId)}`}`;

    function handleClick(event: MouseEvent<HTMLAnchorElement>) {
        // Preserve open-in-new-tab and similar browser behavior.
        if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
        ) {
            return;
        }

        event.preventDefault();

        if (isPending) {
            return;
        }

        startTransition(async () => {
            const result = await markRoomVisited(roomId);

            if (!result.success) {
                toast.add({
                    type: "error",
                    description: "Failed to update room details",
                });
                return;
            }

            router.push(href);
            onNavigate?.();
        });
    }

    return (
        <Link
            href={href}
            className={className}
            aria-disabled={isPending}
            onClick={handleClick}
        >
            {isPending ? "Joining..." : children}
        </Link>
    );
}
