import { MessageList } from "@multiplayer-ai/ui/chat/message-list";
import type { RoomChatMessage } from "@/features/rooms/types/room";

interface Props {
  currentUserId: string;
  messages: RoomChatMessage[];
  selectedMessageIds: ReadonlySet<string>;
  onMessageSelect(messageId: string, selected: boolean): void;
}
export default function Messages({
  currentUserId,
  messages,
  ...selection
}: Props) {
  return (
    <MessageList
      {...selection}
      messages={messages.map((message) => ({
        id: message.id,
        text: message.text,
        author: {
          name: message.author.name,
          imageUrl: message.author.image_url,
        },
        isOwn: message.author_id === currentUserId,
        deliveryStatus: message.deliveryStatus,
      }))}
    />
  );
}
