import { SidebarInset, SidebarProvider } from "@/components/ui/Sidebar";
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { getJoinedRooms } from "@/features/rooms/queries/getJoinedRooms";
import { ThreadSessionProvider } from "@/features/threads/session/ThreadSessionProvider";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppSidebar } from "./_components/AppSidebar";

type AuthenticatedLayoutProps = {
    children: ReactNode;
};

export default async function AuthenticatedLayout({
    children,
}: AuthenticatedLayoutProps) {
    const user = await getCurrentUser();
    if (user === null) {
        redirect("/auth/login");
    }
    const rooms = await getJoinedRooms(user.id);

    return (
        <ThreadSessionProvider key={user.id} userId={user.id}>
            <SidebarProvider>
                <AppSidebar rooms={rooms} />
                <SidebarInset>{children}</SidebarInset>
            </SidebarProvider>
        </ThreadSessionProvider>
    );
}
