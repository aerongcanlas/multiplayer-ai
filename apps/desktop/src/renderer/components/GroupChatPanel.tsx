import { MessageList } from "@multiplayer-ai/ui/chat/message-list";
import type { ChatMessage } from "@multiplayer-ai/ui/chat/types";
import { useChatScroll } from "@multiplayer-ai/ui/hooks/use-chat-scroll";
import { MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { Room } from "../../shared/contracts";
import { perform } from "../lib/desktop-store";
import { Button } from "./ui/Button";
import { PromptInput } from "./PromptInput";
import { timeLabel } from "../lib/time";

export function GroupChatPanel({
  room,
  disabled,
  unavailable,
}: {
  room: Room;
  disabled: boolean;
  unavailable: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [outgoing, setOutgoing] = useState<ChatMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const { containerRef: scroll, scrollToBottom } = useChatScroll();
  useEffect(scrollToBottom, [
    room.messages.length,
    outgoing.length,
    scrollToBottom,
  ]);
  async function send(text: string) {
    const id = crypto.randomUUID();
    setOutgoing((current) => [
      ...current,
      {
        id,
        text,
        author: { name: "You" },
        isOwn: true,
        deliveryStatus: "sending",
      },
    ]);
    setDraft("");
    const sent = Boolean(
      await perform(() => window.desktop.sendMessage(room.id, text)),
    );
    setOutgoing((current) =>
      sent
        ? current.filter((message) => message.id !== id)
        : current.map((message) =>
            message.id === id
              ? { ...message, deliveryStatus: "failed" }
              : message,
          ),
    );
    return sent;
  }
  async function suggest() {
    setGenerating(true);
    try {
      const result = await perform(() =>
        window.desktop.createSuggestion(room.id, Array.from(selectedIds)),
      );
      if (result) setSelectedIds(new Set());
    } finally {
      setGenerating(false);
    }
  }
  return (
    <section className="panel chat-panel" aria-label="Group Chat">
      <header className="panel-header">
        <h2>
          <MessageSquare size={15} />
          Group Chat
        </h2>
        <span className="subtle">
          {room.shared ? "Shared with members" : "Saved locally"}
        </span>
      </header>
      <div className="panel-scroll chat-messages" ref={scroll}>
        {room.messages.length === 0 && outgoing.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={25} />
            <h3>Keep the conversation human</h3>
            <p>
              Add ideas, constraints, or corrections. Select messages to turn
              them into an editable direction.
            </p>
            <span className="subtle">
              {room.shared
                ? "Messages sync with everyone in this room."
                : "This room is saved only on your desktop."}
            </span>
          </div>
        ) : (
          <MessageList
            appearance="compact"
            showAvatars={false}
            disabled={disabled}
            messages={[
              ...room.messages.map((message) => ({
                id: message.id,
                text: message.text,
                author: { name: message.authorName },
                isOwn: !room.shared || message.authorId === room.shared.userId,
                selectionLabel: `Select message: ${message.text.slice(0, 60)}`,
                footer: (
                  <>
                    {message.authorName} · {timeLabel(message.createdAt)}
                  </>
                ),
              })),
              ...outgoing.map((message) => ({
                ...message,
                footer:
                  message.deliveryStatus === "failed" ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={Boolean(draft)}
                      title={
                        draft
                          ? "Clear the current draft to restore this message"
                          : undefined
                      }
                      onClick={() => {
                        setDraft(message.text);
                        setOutgoing((current) =>
                          current.filter((item) => item.id !== message.id),
                        );
                      }}
                    >
                      Use as draft
                    </Button>
                  ) : undefined,
              })),
            ]}
            selectedMessageIds={selectedIds}
            onMessageSelect={(id, checked) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              })
            }
          />
        )}
      </div>
      {selectedIds.size > 0 && (
        <div className="selection-bar">
          <span aria-live="polite">{selectedIds.size} selected</span>
          <div>
            <Button
              size="xs"
              disabled={disabled || generating}
              onClick={() => void suggest()}
              aria-busy={generating}
            >
              <Sparkles size={12} />
              {generating ? "Generating prompts..." : "Suggest prompts"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={generating}
              onClick={() => setSelectedIds(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      )}
      <div className="panel-composer">
        <PromptInput
          targetKey={room.id}
          label="Group chat message"
          maxLength={room.shared ? 2000 : 8000}
          placeholder="Share an idea or constraint..."
          submitLabel="Send message"
          value={draft}
          onChange={setDraft}
          disabled={unavailable}
          busy={disabled}
          onSubmit={send}
        />
      </div>
    </section>
  );
}
