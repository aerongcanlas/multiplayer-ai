"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton() {
    const router = useRouter();

    const logout = async () => {
        const supabase = createClient();
        await supabase.auth.signOut();
        router.push("/auth/login");
    };

    return (
        <Button
            onClick={logout}
            variant="outline"
            size="sm"
        >
            Logout
        </Button>
    );
}
