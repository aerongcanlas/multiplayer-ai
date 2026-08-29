import { SidebarInset, SidebarProvider } from "@/components/ui/Sidebar";
import { getCurrentUser } from "@/features/auth/server/getCurrentUser";
import RoomList from "@/features/rooms/components/RoomList";
import { getJoinedRooms } from "@/features/rooms/queries/getJoinedRooms";
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
            <SidebarInset>{children}</SidebarInset>
        </SidebarProvider>
    );
}
