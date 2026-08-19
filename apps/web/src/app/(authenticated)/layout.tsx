import { AppSidebar } from "@/components/ui/AppSidebar";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/Sidebar";
import type { ReactNode } from "react";

type AuthenticatedLayoutProps = {
    children: ReactNode;
};

export default function AuthenticatedLayout({
    children,
}: AuthenticatedLayoutProps) {
    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
                <SidebarTrigger />
                {children}
            </SidebarInset>
        </SidebarProvider>
    );
}
