import { createInMemoryRunStore, type RunStore } from "@multiplayer-ai/orchestration";

const globalForRunStore = globalThis as unknown as { __runStore?: RunStore };

export function getRunStore(): RunStore {
    return (globalForRunStore.__runStore ??= createInMemoryRunStore());
}
