import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from '@/components/ui';
import AIActivityPanel from './_panels/AIActivityPanel';
import GroupChatPanel from './_panels/GroupChatPanel';
import PromptVotePanel from './_panels/PromptVotePanel';
import RoomListPanel from './_panels/RoomListPanel';

function RoomPage() {
    return (
        <ResizablePanelGroup
            orientation='horizontal'
            className='min-h-screen w-full'
        >
            <ResizablePanel
                defaultSize='10%'
                minSize='10%'
                maxSize='15%'
            >
                <RoomListPanel />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
                defaultSize='27%'
                minSize='15%'
            >
                <AIActivityPanel />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
                defaultSize='55%'
                minSize='30%'
            >
                <ResizablePanelGroup orientation='vertical'>
                    <ResizablePanel
                        defaultSize='70%'
                        minSize='30%'
                    >
                        <GroupChatPanel />
                    </ResizablePanel>

                    <ResizableHandle />

                    <ResizablePanel
                        defaultSize='30%'
                        minSize='15%'
                    >
                        <PromptVotePanel />
                    </ResizablePanel>
                </ResizablePanelGroup>
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
export default RoomPage;
