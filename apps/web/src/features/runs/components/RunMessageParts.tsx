import { TextBox } from "@/components/ui";
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
                        <TextBox
                            key={key}
                            className="m-2 whitespace-pre-wrap"
                        >
                            {part.text}
                        </TextBox>
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

                if (part.type === "data-run.compacted") {
                    return (
                        <TextBox
                            key={key}
                            className="mx-2 text-xs text-white/40"
                        >
                            Context compacted — older detail was dropped to stay in
                            the window.
                        </TextBox>
                    );
                }

                return null;
            })}
        </>
    );
}

export default RunMessageParts;
