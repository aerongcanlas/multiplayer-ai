import type { RunRecord, RunStore } from "./ports";

export function createInMemoryRunStore(): RunStore {
    const records = new Map<string, RunRecord>();
    return {
        async load(runId) {
            return records.get(runId);
        },
        async save(record) {
            records.set(record.input.runId, record);
        },
    };
}
