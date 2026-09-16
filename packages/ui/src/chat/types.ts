import type { ReactNode } from "react";

/** Display data only. Apps adapt their persisted records and delivery state. */
export interface ChatMessage {
  id: string;
  text: string;
  author: { name: string; imageUrl?: string | null };
  isOwn: boolean;
  deliveryStatus?: "sending" | "failed";
  selectionLabel?: string;
  footer?: ReactNode;
}
