import { Box, Spinner, TextBox } from "@/components/ui";
import type { RunTools } from "@multiplayer-ai/domain";
import { getToolName, type ToolUIPart } from "ai";

interface Props {
    part: ToolUIPart<Omit<RunTools, "delegate">>;
}

function summarizeInput(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const record = input as Record<string, unknown>;
    if (typeof record.path === "string") return record.path;
    if (typeof record.query === "string") return record.query;
    const json = JSON.stringify(record);
    return json.length > 60 ? `${json.slice(0, 60)}…` : json;
}

function ToolRow({ part }: Props) {
    const name = getToolName(part);
    const summary = summarizeInput(part.input);

    return (
        <Box className="mx-2 my-1 flex items-center gap-2 text-sm text-white/60">
            {part.state === "output-error" ? (
                <span className="size-1.5 shrink-0 rounded-full bg-red-500" />
            ) : part.state === "output-available" ? (
                <span className="size-1.5 shrink-0 rounded-full bg-white/40" />
            ) : (
                <Spinner className="size-3" />
            )}
            <TextBox className="truncate">
                <span className="text-white/80">{name}</span>
                {summary && <span className="text-white/40"> {summary}</span>}
            </TextBox>
            {part.state === "output-error" && (
                <TextBox className="truncate text-red-400/80">{part.errorText}</TextBox>
            )}
        </Box>
    );
}

export default ToolRow;
