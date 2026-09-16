import type { Room } from "./contracts";

export const currentSummary = (room: Room) => room.summaries.at(-1);
export const currentExecution = (room: Room) => room.executions.at(-1);
