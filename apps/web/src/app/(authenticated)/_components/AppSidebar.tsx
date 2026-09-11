"use client";

import {
    BoxRow,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Separator,
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarRail,
} from "@/components/ui";
import { LogoutButton } from "@/features/auth/components/LogoutButton";
import { useCurrentUser } from "@/features/auth/hooks/useCurrentUser";
import RoomList from "@/features/rooms/components/RoomList";
import type { JoinedRoom } from "@/features/rooms/types/room";
import { MenuIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

interface Props {
    rooms: JoinedRoom[];
}

const MOBILE_NAV_QUERY = "(max-width: 767px)";

function SidebarContents({
    rooms,
    onNavigate,
}: Props & { onNavigate?: () => void }) {
    const { user, isLoading } = useCurrentUser();

    return (
        <>
            <SidebarHeader>
                <Link href="/" className="text-xl font-bold">
                    Multiplayer.ai
                </Link>
                {isLoading || user == null ? (
                    <Button>
                        <Link href="/auth/login">Sign In</Link>
                    </Button>
                ) : (
                    <BoxRow className="gap-2 items-center justify-center">
                        <Button>
                            {user.user_metadata?.preferred_username ||
                                user.email}
                        </Button>
                        <LogoutButton />
                    </BoxRow>
                )}
            </SidebarHeader>
            <Separator />
            <SidebarContent className="m-2">
                <p className="text-lg font-bold">Rooms</p>
                <RoomList
                    title="Your Rooms"
                    rooms={rooms}
                    variant="short"
                    onNavigate={onNavigate}
                />
            </SidebarContent>
            <SidebarFooter />
        </>
    );
}

export function AppSidebar({ rooms }: Props) {
    const [isMobile, setIsMobile] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);

    useEffect(() => {
        const query = window.matchMedia(MOBILE_NAV_QUERY);
        const update = () => setIsMobile(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);

    if (isMobile) {
        return (
            <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
                <DialogTrigger
                    render={
                        <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className="fixed top-2 left-2 z-40 bg-background"
                            aria-label="Open room navigation"
                        />
                    }
                >
                    <MenuIcon />
                </DialogTrigger>
                <DialogContent className="top-0 left-0 h-svh w-[min(20rem,calc(100%-2rem))] max-w-none translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none rounded-r-xl">
                    <DialogHeader>
                        <DialogTitle>Multiplayer.ai</DialogTitle>
                        <DialogDescription>
                            Choose a room or one of your AI threads.
                        </DialogDescription>
                    </DialogHeader>
                    <SidebarContents
                        rooms={rooms}
                        onNavigate={() => setMobileOpen(false)}
                    />
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Sidebar>
            <SidebarContents rooms={rooms} />
            <SidebarRail />
        </Sidebar>
    );
}
