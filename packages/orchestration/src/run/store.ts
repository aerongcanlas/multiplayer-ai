import { emptyThread, type RunStore, type ThreadRecord } from "./ports";

export function createInMemoryRunStore(): RunStore {
    const threads = new Map<string, ThreadRecord>();
    return {
        async load(roomId) {
            return threads.get(roomId) ?? emptyThread();
        },
        async save(roomId, record) {
            threads.set(roomId, record);
        },
        async clear(roomId) {
            threads.delete(roomId);
        },
    };
}
