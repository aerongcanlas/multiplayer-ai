import { z } from "zod";

export const runConfigurationSchema = z
  .object({
    model: z.string().min(1).max(120),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    mode: z.enum(["read-only", "worktree"]).default("read-only"),
    concurrency: z.number().int().min(1).max(3).default(2),
  })
  .strict();
export type RunConfiguration = z.infer<typeof runConfigurationSchema>;
export interface ProviderModel {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
}
export interface ProviderState {
  status:
    "disconnected" | "connecting" | "signing_in" | "connected" | "unavailable";
  message: string;
  version?: string;
  account?: { label: string; plan: string };
  models: ProviderModel[];
  limits: { name: string; usedPercent: number; resetsAt: number | null }[];
}
export interface RunApproval {
  id: string;
  taskId: string;
  title: string;
  detail: string;
  createdAt: string;
}
