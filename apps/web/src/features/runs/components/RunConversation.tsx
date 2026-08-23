"use client";

import ChatMessageBubble from "@/components/ChatMessageBubble";
import { Box, BoxColumn } from "@/components/ui";
import type { RunUIMessage } from "@/features/runs/types/runMessage";
import { useEffect, useRef } from "react";
import RunMessageParts from "./RunMessageParts";

const STICK_TO_BOTTOM_THRESHOLD_PX = 40;

interface Props {
    messages: Array<RunUIMessage>;
}

function RunConversation({ messages }: Props) {
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
                        <ChatMessageBubble
                            key={message.id}
                            className="self-end"
                            message={{
                                text: message.parts
                                    .map((part) => (part.type === "text" ? part.text : ""))
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
