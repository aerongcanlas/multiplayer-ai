import { Box, BoxColumn, TextBox } from "@/components/ui";
import type { Message } from "../../types/message";
import Messages from "./Messages";

function GroupChatPanel() {
    const messages: Array<Pick<Message, "id" | "userId" | "text">> = [
        { id: "1", userId: "2", text: "hey" },
        { id: "2", userId: "1", text: "wassup" },
        { id: "3", userId: "2", text: "how are ya?" },
    ];
    return (
        <BoxColumn className="h-full min-h-0 p-2">
            <TextBox className="shrink-0">GroupChatPanel</TextBox>
            <Box className="min-h-0 flex-1 overflow-y-auto">
                <Messages messages={messages} />
            </Box>
            {/* <TextEntryBubble className='m-2 mt-2 rounded-2xl shrink-0 h-20' /> */}
        </BoxColumn>
    );
}
export default GroupChatPanel;
