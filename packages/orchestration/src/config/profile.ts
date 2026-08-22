import type { EffortLevel } from "@multiplayer-ai/domain";

export type Profile = {
    leadMaxSteps: number;
    scoutMaxSteps: number;
    verificationPass: boolean;
    /** Stop the loop if the run exceeds this many total output tokens. */
    tokenBudget: number;
    /** Results per web search. Tavily caps at 20. */
    searchMaxResults: number;
    /** Tavily depth: "basic" = 1 credit, "advanced" = 2 credits, higher relevance. */
    searchDepth: "basic" | "advanced";
};

const PROFILES: Record<EffortLevel, Profile> = {
    low: {
        leadMaxSteps: 5,
        scoutMaxSteps: 3,
        verificationPass: false,
        tokenBudget: 20_000,
        searchMaxResults: 3,
        searchDepth: "basic",
    },
    med: {
        leadMaxSteps: 12,
        scoutMaxSteps: 6,
        verificationPass: true,
        tokenBudget: 60_000,
        searchMaxResults: 5,
        searchDepth: "basic",
    },
    high: {
        leadMaxSteps: 20,
        scoutMaxSteps: 10,
        verificationPass: true,
        tokenBudget: 150_000,
        searchMaxResults: 5,
        searchDepth: "basic",
    },
};

const DEFAULT_EFFORT: EffortLevel = "med";

export function resolveProfile(effort?: EffortLevel): Profile {
    return PROFILES[effort ?? DEFAULT_EFFORT];
}
