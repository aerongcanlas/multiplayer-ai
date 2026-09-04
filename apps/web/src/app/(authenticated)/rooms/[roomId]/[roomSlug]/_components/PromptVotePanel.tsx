"use client";

import { Box, BoxColumn, Button, Spinner } from "@/components/ui";
import { usePromptSuggestions } from "./PromptSuggestionProvider";

function MissionControlPanel() {
    const { suggestion, isGenerating, error, draftPrompt, setDraftPrompt } =
        usePromptSuggestions();

    return (
        <BoxColumn className="h-full min-h-0 gap-2 p-2">
            <div className="flex shrink-0 items-center justify-between gap-2 px-1">
                <p className="text-sm font-medium">Mission Control</p>
                {isGenerating && (
                    <Spinner aria-label="Generating suggestions" />
                )}
            </div>

            {isGenerating && (
                <p
                    aria-live="polite"
                    className="px-1 text-xs text-muted-foreground"
                >
                    Summarizing selected messages...
                </p>
            )}

            {error !== null && (
                <p
                    role="alert"
                    className="rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                >
                    {error}
                </p>
            )}

            {!isGenerating && error === null && suggestion === null && (
                <p className="px-1 text-xs text-muted-foreground">
                    Select room messages, then choose Suggest prompts.
                </p>
            )}

            {suggestion !== null && (
                <BoxColumn className="min-h-0 flex-1 gap-2 overflow-y-auto">
                    <Box className="rounded-lg border border-border bg-card p-2">
                        <p className="text-xs font-medium">
                            {suggestion.actionable
                                ? "Context summary"
                                : "More direction needed"}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {suggestion.summary}
                        </p>
                    </Box>

                    {suggestion.suggestedPrompts.map((prompt, index) => (
                        <Box
                            key={`${suggestion.sourceMessageIds.join(":")}:${index}`}
                            className="rounded-lg border border-border bg-card p-2"
                        >
                            <p className="whitespace-pre-wrap text-xs leading-relaxed">
                                {prompt}
                            </p>
                            <div className="mt-2 flex justify-end">
                                <Button
                                    size="xs"
                                    type="button"
                                    variant={
                                        draftPrompt === prompt
                                            ? "secondary"
                                            : "outline"
                                    }
                                    onClick={() => setDraftPrompt(prompt)}
                                >
                                    {draftPrompt === prompt
                                        ? "In composer"
                                        : "Use prompt"}
                                </Button>
                            </div>
                        </Box>
                    ))}
                </BoxColumn>
            )}
        </BoxColumn>
    );
}
export default MissionControlPanel;
