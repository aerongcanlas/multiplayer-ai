export type RunLockMode = "exclusive" | "off";

export const RUN_LOCK_MODE: RunLockMode = "exclusive";

export const runLockEnabled = RUN_LOCK_MODE === "exclusive";
