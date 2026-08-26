"use client";

import { Box, BoxColumn, TextBox } from "@/components/ui";
import RunMessageBubble from "@/features/runs/components/RunMessageBubble";
import type { RunUIMessage } from "@multiplayer-ai/domain";
import { useEffect, useRef } from "react";
import RunMessageParts from "./RunMessageParts";

const STICK_TO_BOTTOM_THRESHOLD_PX = 40;

function messageText(message: RunUIMessage): string {
    return message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
}

interface Props {
    messages: Array<RunUIMessage>;
    incomplete?: boolean;
}

function RunConversation({ messages, incomplete }: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const stuckToBottomRef = useRef(true);

    useEffect(() => {
        const scrollNode = scrollRef.current;
        const contentNode = contentRef.current;
        if (!scrollNode || !contentNode) return;

        const observer = new ResizeObserver(() => {
            if (!stuckToBottomRef.current) return;
            scrollNode.scrollTop = scrollNode.scrollHeight;
        });
        observer.observe(contentNode);
        return () => observer.disconnect();
    }, []);

    const handleScroll = () => {
        const node = scrollRef.current;
        if (!node) return;
        const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
        stuckToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
    };

    const lastMessageId = messages.at(-1)?.id;
    useEffect(() => {
        stuckToBottomRef.current = true;
    }, [lastMessageId]);

    return (
        <Box
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto"
        >
            <BoxColumn ref={contentRef}>
                {messages.map((message) =>
                    message.role === "user" ? (
                        <RunMessageBubble
                            key={message.id}
                            className="self-end"
                            author={message.metadata?.author?.name}
                            text={messageText(message)}
                        />
                    ) : (
                        <RunMessageParts
                            key={message.id}
                            message={message}
                        />
                    ),
                )}
                {incomplete && messages.length > 0 && (
                    <TextBox className="m-2 text-xs text-white/40">
                        Cut off before finishing.
                    </TextBox>
                )}
            </BoxColumn>
        </Box>
    );
}

export default RunConversation;
