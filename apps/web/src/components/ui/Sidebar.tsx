"use client";
import type { ComponentProps } from "react";
import { SidebarProvider as SharedSidebarProvider } from "@multiplayer-ai/ui/primitives/sidebar";
export * from "@multiplayer-ai/ui/primitives/sidebar";
function persistSidebar(open: boolean) {
  document.cookie = `sidebar_state=${open}; path=/; max-age=604800`;
}
export function SidebarProvider(
  props: ComponentProps<typeof SharedSidebarProvider>,
) {
  return <SharedSidebarProvider onPersistOpen={persistSidebar} {...props} />;
}
