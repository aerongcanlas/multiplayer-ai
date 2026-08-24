"use client";

import { Box, BoxColumn } from "@/components/ui";
import RunMessageBubble from "@/features/runs/components/RunMessageBubble";
import type { RunUIMessage } from "@/features/runs/types/runMessage";
import { useEffect, useRef } from "react";
import RunMessageParts from "./RunMessageParts";

interface Props {
    messages: Array<RunUIMessage>;
}

function RunConversation({ messages }: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);

    const streamedLength = messages.reduce((total, message) => {
        return (
            total +
            message.parts.reduce((partTotal, part) => {
                if (part.type === "text" || part.type === "reasoning") {
                    return partTotal + part.text.length;
                }
                return partTotal + 1;
            }, 0)
        );
    }, 0);

    useEffect(() => {
        const node = scrollRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
    }, [streamedLength]);

    return (
        <Box
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
        >
            <BoxColumn>
                {messages.map((message) =>
                    message.role === "user" ? (
                        <RunMessageBubble
                            key={message.id}
                            className="self-end"
                            message={{
                                text: message.parts
                                    .map((part) =>
                                        part.type === "text" ? part.text : "",
                                    )
                                    .join(""),
                            }}
                        />
                    ) : (
                        <RunMessageParts
                            key={message.id}
                            message={message}
                        />
                    ),
                )}
            </BoxColumn>
        </Box>
    );
}

export default RunConversation;
