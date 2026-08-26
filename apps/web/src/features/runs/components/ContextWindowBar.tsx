import { getContextWindow, type ModelKey } from "@multiplayer-ai/domain";
import { TextBox } from "@/components/ui";
import type { RunUIMessage } from "@/features/runs/types/runMessage";

interface Props {
    messages: Array<RunUIMessage>;
    model: ModelKey;
}

const COMPACTION_THRESHOLD_RATIO = 0.8;

function findLastAssistantMetadata(messages: Array<RunUIMessage>) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "assistant" && message.metadata) {
            return message.metadata;
        }
    }
    return undefined;
}

function formatTokenCount(count: number): string {
    if (count >= 1000) return `${Math.round(count / 1000)}k`;
    return `${count}`;
}

function ContextWindowBar({ messages, model }: Props) {
    const metadata = findLastAssistantMetadata(messages);
    const windowSize = getContextWindow(model);
    const known = metadata !== undefined && metadata.model === model;

    if (!known) {
        return (
            <div className="mx-2 flex items-center gap-2">
                <div className="h-[3px] flex-1 rounded-full bg-white/10" />
                <TextBox className="text-[10px] whitespace-nowrap text-white/30">
                    context unknown
                </TextBox>
            </div>
        );
    }

    const used = Math.min(metadata.inputTokens, windowSize);
    const usedRatio = used / windowSize;
    const remaining = Math.max(windowSize - used, 0);
    const nearLimit = usedRatio >= COMPACTION_THRESHOLD_RATIO;

    return (
        <div className="mx-2 flex items-center gap-2">
            <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                    className={nearLimit ? "h-full bg-red-400/80" : "h-full bg-white/40"}
                    style={{ width: `${Math.min(usedRatio * 100, 100)}%` }}
                />
            </div>
            <TextBox className="text-[10px] whitespace-nowrap text-white/40">
                {formatTokenCount(remaining)} left
            </TextBox>
        </div>
    );
}

export default ContextWindowBar;
