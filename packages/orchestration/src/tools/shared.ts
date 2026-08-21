import type { RunEvent, SearchFn } from "@multiplayer-ai/domain";
import type { Profile } from "../config/profile";
import type { EventSink } from "../run/ports";

export type ToolDeps = {
    runId: string;
    roomId: string;
    search: SearchFn;
    sink: EventSink;
    profile: Profile;
};

type ExecOptions = { abortSignal?: AbortSignal };

export function traced<A, R>(
    deps: ToolDeps,
    name: string,
    fn: (args: A, options: ExecOptions) => Promise<R>,
): (args: A, options: ExecOptions) => Promise<R> {
    return async (args: A, options: ExecOptions) => {
        const startedAt = Date.now();
        try {
            const result = await fn(args, options);
            await deps.sink.emit({
                kind: "run.tool",
                runId: deps.runId,
                tool: name,
                ms: Date.now() - startedAt,
                ok: true,
            } satisfies RunEvent);
            return result;
        } catch (error) {
            await deps.sink.emit({
                kind: "run.tool",
                runId: deps.runId,
                tool: name,
                ms: Date.now() - startedAt,
                ok: false,
            } satisfies RunEvent);
            throw error;
        }
    };
}
