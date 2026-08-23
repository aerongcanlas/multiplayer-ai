import { Markdown, TextBox } from "@/components/ui";
import type { RunUIMessage } from "@/features/runs/types/runMessage";
import { isToolUIPart } from "ai";
import DelegationCard from "./DelegationCard";
import ReasoningBlock from "./ReasoningBlock";
import SearchResultsCard from "./SearchResultsCard";
import ToolRow from "./ToolRow";
import VerifyBadge from "./VerifyBadge";

interface Props {
    message: RunUIMessage;
}

function RunMessageParts({ message }: Props) {
    return (
        <>
            {message.parts.map((part, index) => {
                const key = `${message.id}-${index}`;

                if (part.type === "reasoning") {
                    return <ReasoningBlock key={key} part={part} />;
                }

                if (part.type === "text") {
                    if (!part.text) return null;
                    return (
                        <Markdown
                            key={key}
                            className="m-2 text-white/80"
                            isAnimating={part.state === "streaming"}
                        >
                            {part.text}
                        </Markdown>
                    );
                }

                if (isToolUIPart(part)) {
                    if (part.type === "dynamic-tool") return null;
                    if (part.type === "tool-delegate") {
                        return <DelegationCard key={key} part={part} />;
                    }
                    if (part.type === "tool-webSearch") {
                        return <SearchResultsCard key={key} part={part} />;
                    }
                    return <ToolRow key={key} part={part} />;
                }

                if (part.type === "data-run.started") {
                    return (
                        <TextBox
                            key={key}
                            className="mx-2 mt-2 text-xs text-white/40"
                        >
                            {part.data.goal} · {part.data.model}
                        </TextBox>
                    );
                }

                if (part.type === "data-run.verify") {
                    return (
                        <VerifyBadge
                            key={key}
                            ok={part.data.ok}
                            issues={part.data.issues}
                        />
                    );
                }

                if (part.type === "data-run.no_action") {
                    return (
                        <TextBox
                            key={key}
                            className="m-2 text-sm text-white/50"
                        >
                            {part.data.reason}
                        </TextBox>
                    );
                }

                if (part.type === "data-run.failed") {
                    return (
                        <TextBox
                            key={key}
                            className="m-2 text-sm text-red-400/80"
                        >
                            Run failed: {part.data.error}
                        </TextBox>
                    );
                }

                if (part.type === "data-run.cancelled") {
                    return (
                        <TextBox
                            key={key}
                            className="m-2 text-sm text-white/40"
                        >
                            Run cancelled.
                        </TextBox>
                    );
                }

                // run.delegated / run.delegate.done / run.delegate.failed / run.finished
                // carry no extra UI — the native tool-delegate part and the report text
                // already cover it.
                return null;
            })}
        </>
    );
}

export default RunMessageParts;
