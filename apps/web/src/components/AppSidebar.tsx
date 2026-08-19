"use client";

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarHeader,
} from "@/components/ui/Sidebar";
import { BoxRow, Button } from "@/components/ui";
import { LogoutButton } from "@/features/auth/components/LogoutButton";
import { useCurrentUser } from "@/features/auth/hooks/useCurrentUser";
import Link from "next/link";

export function AppSidebar() {
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
            <SidebarContent>
                <SidebarGroup />
                <SidebarGroup />
            </SidebarContent>
            <SidebarFooter />
        </Sidebar>
    );
}
