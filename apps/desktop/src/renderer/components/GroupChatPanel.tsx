import { MessageList } from "@multiplayer-ai/ui/chat/message-list";
import { useChatScroll } from "@multiplayer-ai/ui/hooks/use-chat-scroll";
import { MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { Room } from "../../shared/contracts";
import { perform } from "../lib/desktop-store";
import { Button } from "./ui/Button";
import { PromptInput } from "./PromptInput";
import { timeLabel } from "./StatusBadge";

export function GroupChatPanel({
  room,
  disabled,
}: {
  room: Room;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const { containerRef: scroll, scrollToBottom } = useChatScroll();
  useEffect(scrollToBottom, [room.messages.length, scrollToBottom]);
  async function suggest() {
    const result = await perform(() =>
      window.desktop.createSuggestion(room.id, Array.from(selectedIds)),
    );
    if (result) setSelectedIds(new Set());
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
        {room.messages.length === 0 ? (
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
            messages={room.messages.map((message) => ({
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
            }))}
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
              disabled={disabled}
              onClick={() => void suggest()}
            >
              <Sparkles size={12} />
              Suggest prompts
            </Button>
            <Button
              size="xs"
              variant="ghost"
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
          disabled={disabled}
          onSubmit={async (text) =>
            Boolean(
              await perform(() => window.desktop.sendMessage(room.id, text)),
            )
          }
        />
      </div>
    </section>
  );
}
