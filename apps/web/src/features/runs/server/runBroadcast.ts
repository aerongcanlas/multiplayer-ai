import type { RunThreadEvent } from "@multiplayer-ai/domain";
import { RUN_THREAD_EVENT, runThreadTopic } from "@multiplayer-ai/domain";
import { createAdminClient } from "@/lib/supabase/server";

export type RunBroadcaster = {
    send(event: RunThreadEvent): Promise<void>;
    close(): Promise<void>;
};

export const NO_BROADCAST: RunBroadcaster = {
    async send() {},
    async close() {},
};

export function createSupabaseBroadcaster(roomId: string): RunBroadcaster {
    const supabase = createAdminClient();
    const channel = supabase.channel(runThreadTopic(roomId), {
        config: { private: true },
    });

    return {
        async send(event) {
            try {
                await channel.httpSend(RUN_THREAD_EVENT, event);
            } catch (error) {
                // Rows are the truth; a dropped announcement costs latency, not content.
                console.error(`[broadcast ${roomId}]`, error);
            }
        },
        async close() {
            await supabase.removeChannel(channel);
        },
    };
}
