"use client";

import {
    BoxRow,
    Button,
    Separator,
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
} from "@/components/ui";
import { LogoutButton } from "@/features/auth/components/LogoutButton";
import { useCurrentUser } from "@/features/auth/hooks/useCurrentUser";
import Link from "next/link";
import type { ReactNode } from "react";

interface Props {
    roomList: ReactNode;
}

export function AppSidebar({ roomList }: Props) {
    const { user, isLoading } = useCurrentUser();

    return (
        <Sidebar>
            <SidebarHeader>
                <Link
                    href="/"
                    className="text-xl font-bold"
                >
                    Multiplayer.ai
                </Link>
                {isLoading || user == null ? (
                    <Button>
                        <Link href="/auth/login">Sign In</Link>
                    </Button>
                ) : (
                    <BoxRow>
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
                {roomList}
            </SidebarContent>
            <SidebarFooter />
        </Sidebar>
    );
}
