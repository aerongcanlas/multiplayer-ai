"use client";

import type { ReactNode } from "react";
import {
    Box,
    BoxColumn,
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui";

type RoomWorkspaceProps = {
    header: ReactNode;
    aiPanel: ReactNode;
    memberChatPanel: ReactNode;
    promptPanel: ReactNode;
};

/**
 * One panel tree adapts between a resizable desktop workspace and a vertically
 * scrollable mobile workspace. Keeping the children mounted preserves live
 * thread observers and room-chat state across viewport changes.
 */
export function RoomWorkspace({
    header,
    aiPanel,
    memberChatPanel,
    promptPanel,
}: RoomWorkspaceProps) {
    return (
        <ResizablePanelGroup
            orientation="vertical"
            className="min-h-screen w-full max-md:!block max-md:!h-auto max-md:overflow-visible"
        >
            <ResizablePanel
                defaultSize="60%"
                minSize="40%"
                className="max-md:!h-auto max-md:!overflow-visible"
            >
                <BoxColumn className="h-full min-h-0 max-md:h-auto">
                    {header}
                    <Box className="min-h-0 flex-1 max-md:h-auto max-md:flex-none">
                        <ResizablePanelGroup className="max-md:!block max-md:!h-auto max-md:overflow-visible">
                            <ResizablePanel
                                defaultSize="60%"
                                minSize="30%"
                                className="max-md:!h-auto max-md:!min-h-[32rem] max-md:!overflow-visible"
                            >
                                {aiPanel}
                            </ResizablePanel>

                            <ResizableHandle className="max-md:hidden" />

                            <ResizablePanel
                                minSize="30%"
                                className="max-md:!h-auto max-md:!min-h-[28rem] max-md:!overflow-visible"
                            >
                                {memberChatPanel}
                            </ResizablePanel>
                        </ResizablePanelGroup>
                    </Box>
                </BoxColumn>
            </ResizablePanel>

            <ResizableHandle className="max-md:hidden" />

            <ResizablePanel
                defaultSize="40%"
                minSize="30%"
                className="max-md:!h-auto max-md:!min-h-[26rem] max-md:!overflow-visible"
            >
                {promptPanel}
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
