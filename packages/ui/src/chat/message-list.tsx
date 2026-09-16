"use client";

import { Avatar, AvatarFallback, AvatarImage } from "../primitives/avatar";
import { Bubble, BubbleContent } from "../primitives/bubble";
import { Checkbox } from "../primitives/checkbox";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
} from "../primitives/message";
import { cn } from "../lib/utils";
import type { ChatMessage } from "./types";

export interface MessageListProps {
  messages: readonly ChatMessage[];
  selectedMessageIds: ReadonlySet<string>;
  onMessageSelect(id: string, selected: boolean): void;
  disabled?: boolean;
  showAvatars?: boolean;
  appearance?: "default" | "compact";
}

export function MessageList({
  messages,
  selectedMessageIds,
  onMessageSelect,
  disabled = false,
  showAvatars = true,
  appearance = "default",
}: MessageListProps) {
  const compact = appearance === "compact";
  return (
    <div data-slot="chat-message-list" className="flex min-w-0 flex-col">
      {messages.map((message) => (
        <Message
          key={message.id}
          align={message.isOwn ? "end" : "start"}
          className={cn("group/select", compact ? "chat-message" : "py-1")}
        >
          {showAvatars && (
            <MessageAvatar>
              <Avatar>
                <AvatarImage
                  src={message.author.imageUrl ?? undefined}
                  alt={message.author.name}
                />
                <AvatarFallback>{message.author.name[0]}</AvatarFallback>
              </Avatar>
            </MessageAvatar>
          )}
          <MessageContent>
            <div
              className={
                compact
                  ? "message-bubble-row"
                  : cn(
                      "flex w-full items-center gap-2",
                      message.isOwn && "flex-row-reverse",
                    )
              }
            >
              <Bubble
                variant={message.isOwn ? "own" : "other"}
                align={message.isOwn ? "end" : "start"}
              >
                <BubbleContent>
                  <p className="whitespace-pre-wrap">{message.text}</p>
                </BubbleContent>
              </Bubble>
              <Checkbox
                aria-label={
                  message.selectionLabel ??
                  `Select message from ${message.author.name}`
                }
                className={
                  compact
                    ? "message-select order-first"
                    : "cursor-pointer rounded-full opacity-0 transition-opacity group-hover/select:opacity-100 group-focus-within/select:opacity-100 data-checked:opacity-100"
                }
                checked={selectedMessageIds.has(message.id)}
                disabled={disabled || message.deliveryStatus !== undefined}
                onCheckedChange={(checked) =>
                  onMessageSelect(message.id, checked)
                }
              />
            </div>
            {message.footer != null && (
              <MessageFooter>{message.footer}</MessageFooter>
            )}
            {message.deliveryStatus === "sending" && (
              <MessageFooter>
                <span role="status" className="text-muted-foreground">
                  Sending...
                </span>
              </MessageFooter>
            )}
            {message.deliveryStatus === "failed" && (
              <MessageFooter>
                <span role="alert" className="text-destructive">
                  Failed to send
                </span>
              </MessageFooter>
            )}
          </MessageContent>
        </Message>
      ))}
    </div>
  );
}
