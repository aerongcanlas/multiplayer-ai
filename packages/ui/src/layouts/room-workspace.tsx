"use client";

import type { ReactNode } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../primitives/resizable";
import { cn } from "../lib/utils";

export interface RoomWorkspaceProps {
  header?: ReactNode;
  aiPanel: ReactNode;
  memberChatPanel: ReactNode;
  promptPanel: ReactNode;
  /** A window fills its parent; a page stacks on small screens. Children stay mounted. */
  mode?: "page" | "window";
  className?: string;
  activityResizeLabel?: string;
  promptResizeLabel?: string;
}

export function RoomWorkspace({
  header,
  aiPanel,
  memberChatPanel,
  promptPanel,
  mode = "page",
  className,
  activityResizeLabel = "Resize activity and chat panels",
  promptResizeLabel = "Resize prompt panel",
}: RoomWorkspaceProps) {
  const page = mode === "page";
  return (
    <ResizablePanelGroup
      orientation="vertical"
      className={cn(
        page &&
          "min-h-screen w-full max-md:!block max-md:!h-auto max-md:overflow-visible",
        className,
      )}
    >
      <ResizablePanel
        defaultSize={page ? "60%" : "58%"}
        minSize={page ? "40%" : "35%"}
        className={cn(page && "max-md:!h-auto max-md:!overflow-visible")}
      >
        <div
          className={cn(
            "flex h-full min-h-0 flex-col",
            page && "max-md:h-auto",
          )}
        >
          {header}
          <div
            className={cn(
              "min-h-0 flex-1",
              page && "max-md:h-auto max-md:flex-none",
            )}
          >
            <ResizablePanelGroup
              orientation="horizontal"
              className={cn(
                page && "max-md:!block max-md:!h-auto max-md:overflow-visible",
              )}
            >
              <ResizablePanel
                defaultSize="60%"
                minSize={page ? "30%" : "38%"}
                className={cn(
                  page &&
                    "max-md:!h-auto max-md:!min-h-[32rem] max-md:!overflow-visible",
                )}
              >
                {aiPanel}
              </ResizablePanel>
              <ResizableHandle
                aria-label={activityResizeLabel}
                className={cn(page && "max-md:hidden")}
              />
              <ResizablePanel
                minSize={page ? "30%" : "28%"}
                className={cn(
                  page &&
                    "max-md:!h-auto max-md:!min-h-[28rem] max-md:!overflow-visible",
                )}
              >
                {memberChatPanel}
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle
        aria-label={promptResizeLabel}
        className={cn(page && "max-md:hidden")}
      />
      <ResizablePanel
        defaultSize={page ? "40%" : "42%"}
        minSize={page ? "30%" : "25%"}
        className={cn(
          page &&
            "max-md:!h-auto max-md:!min-h-[26rem] max-md:!overflow-visible",
        )}
      >
        {promptPanel}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
