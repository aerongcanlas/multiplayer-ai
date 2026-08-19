import { AppSidebar } from "@/components/AppSidebar";
import RoomList from "@/components/RoomList";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/Sidebar";
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import { getJoinedRooms } from "@/features/rooms/queries/getJoinedRooms";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

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
        <SidebarProvider>
            <AppSidebar
                roomList={
                    <RoomList
                        title="Your Rooms"
                        rooms={rooms}
                        variant="short"
                    />
                }
            />
            <SidebarInset>
                <SidebarTrigger />
                {children}
            </SidebarInset>
        </SidebarProvider>
    );
}
