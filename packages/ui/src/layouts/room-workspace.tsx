"use client";

import type { ReactNode, Ref } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizablePanelHandle,
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
  /** Lets the prompt panel collapse to this height; its handle collapses and expands it. */
  promptCollapsedSize?: number | string;
  promptPanelRef?: Ref<ResizablePanelHandle | null>;
  onPromptCollapsedChange?(collapsed: boolean): void;
  /** Lets the member chat panel collapse out of view. */
  chatCollapsible?: boolean;
  chatPanelRef?: Ref<ResizablePanelHandle | null>;
  onChatCollapsedChange?(collapsed: boolean): void;
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
  promptCollapsedSize,
  promptPanelRef,
  onPromptCollapsedChange,
  chatCollapsible = false,
  chatPanelRef,
  onChatCollapsedChange,
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
                collapsible={chatCollapsible}
                collapsedSize={0}
                panelRef={chatPanelRef}
                onResize={(size, _id, previous) => {
                  if (!chatCollapsible || !previous) return;
                  const collapsed = (value: number) => value < (page ? 30 : 28);
                  if (
                    collapsed(size.asPercentage) !==
                    collapsed(previous.asPercentage)
                  )
                    onChatCollapsedChange?.(collapsed(size.asPercentage));
                }}
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
        collapsible={promptCollapsedSize !== undefined}
        collapsedSize={promptCollapsedSize}
        panelRef={promptPanelRef}
        onResize={(size, _id, previous) => {
          if (promptCollapsedSize === undefined || !previous) return;
          // Below the minimum size the panel can only be at its collapsed size.
          const collapsed = (value: number) => value < (page ? 30 : 25);
          if (collapsed(size.asPercentage) !== collapsed(previous.asPercentage))
            onPromptCollapsedChange?.(collapsed(size.asPercentage));
        }}
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
