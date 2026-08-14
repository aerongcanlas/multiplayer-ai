import { Box, BoxColumn, TextBox } from '@/components/ui';
import Messages from '../_components/Messages';
import TextEntryBubble from '../_components/TextEntryBubble';
import type { Message } from '../_types/message';

function AIActivityPanel() {
    const messages: Array<Message> = [];
    return (
        <BoxColumn className='h-full min-h-0 p-2'>
            <TextBox className='shrink-0'>AIActivityPanel</TextBox>
            <Box className='min-h-0 flex-1 overflow-y-auto'>
                <Messages messages={messages} />
            </Box>
            <TextEntryBubble
                className='m-2 mt-2 rounded-2xl shrink-0 h-20'
                onSubmit={() => null}
            />
        </BoxColumn>
    );
}
export default AIActivityPanel;
