import { Box, Markdown, Spinner, TextBox } from "@/components/ui";
import type { RunTools } from "@/features/runs/types/runMessage";
import type { ToolUIPart } from "ai";

interface Props {
    part: ToolUIPart<Pick<RunTools, "delegate">>;
}

const CONFIDENCE_LABEL = {
    low: "Low confidence",
    medium: "Medium confidence",
    high: "High confidence",
} as const;

function DelegationCard({ part }: Props) {
    const task = part.input?.task;

    return (
        <Box className="m-2 rounded-xl border border-white/10 bg-[#1E1E1E] px-3 py-2.5 text-sm">
            <TextBox className="text-white/80">
                <span className="font-medium">@scout</span>
                {task && <span className="text-white/50"> — {task}</span>}
            </TextBox>

            {part.state === "output-error" && (
                <TextBox className="mt-1.5 text-red-400/80">{part.errorText}</TextBox>
            )}

            {part.state !== "output-available" && part.state !== "output-error" && (
                <div className="mt-1.5 flex items-center gap-2 text-white/50">
                    <Spinner className="size-3" />
                    <TextBox>Researching…</TextBox>
                </div>
            )}

            {part.state === "output-available" && (
                <div className="mt-1.5 space-y-1.5">
                    <Markdown className="text-white/70">{part.output.summary}</Markdown>
                    {part.output.findings.length > 0 && (
                        <ul className="list-disc space-y-0.5 pl-4 text-white/50">
                            {part.output.findings.map((finding) => (
                                <li key={finding.claim}>
                                    {finding.claim}{" "}
                                    <span className="text-white/30">[{finding.source}]</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {part.output.gaps.length > 0 && (
                        <TextBox className="text-white/40">
                            Gaps: {part.output.gaps.join("; ")}
                        </TextBox>
                    )}
                    <TextBox className="text-white/40">
                        {CONFIDENCE_LABEL[part.output.confidence]}
                    </TextBox>
                </div>
            )}
        </Box>
    );
}

export default DelegationCard;
