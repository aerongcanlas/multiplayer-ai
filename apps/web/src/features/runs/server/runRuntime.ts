import type { ModelKey, RunMessageAuthor } from "@multiplayer-ai/domain";
import {
    createInMemoryRunStore,
    createScriptedRunModel,
    type RunStore,
} from "@multiplayer-ai/orchestration";
import type { LanguageModel } from "ai";
import type { User } from "@supabase/supabase-js";
import {
    NO_BROADCAST,
    createSupabaseBroadcaster,
    type RunBroadcaster,
} from "@/features/runs/server/runBroadcast";
import { createSupabaseRunStore, readUserProfile } from "@/features/runs/server/runStore";

type RunRuntime = {
    /** What the response header reports served the run. */
    describe(model: ModelKey): string;
    modelOverride(): LanguageModel | undefined;
    profile(user: User): Promise<RunMessageAuthor | null>;
    store(): RunStore;
    broadcaster(roomId: string): RunBroadcaster;
};

const isMockMode = process.env.AI_MODE?.trim().toLowerCase() === "mock";

const globalForRunStore = globalThis as unknown as { __runStore?: RunStore };

const mockRuntime: RunRuntime = {
    describe: () => "mock",
    modelOverride: () => createScriptedRunModel(),
    profile: async () => null,
    store: () => (globalForRunStore.__runStore ??= createInMemoryRunStore()),
    broadcaster: () => NO_BROADCAST,
};

const liveRuntime: RunRuntime = {
    describe: (model) => model,
    modelOverride: () => undefined,
    profile: (user) => readUserProfile(user.id),
    store: () => createSupabaseRunStore(),
    broadcaster: (roomId) => createSupabaseBroadcaster(roomId),
};

export const runRuntime: RunRuntime = isMockMode ? mockRuntime : liveRuntime;
