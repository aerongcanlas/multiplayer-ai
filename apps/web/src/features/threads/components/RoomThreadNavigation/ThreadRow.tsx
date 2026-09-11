"use client";

import type {
    ThreadSummary,
    UpdateThreadRequest,
} from "@multiplayer-ai/domain";
import {
    Archive,
    CircleAlert,
    CircleStop,
    Check,
    LoaderCircle,
    Pencil,
    RotateCcw,
    X,
} from "lucide-react";
import { useState } from "react";
import {
    Button,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui";

type ThreadRowProps = {
    summary: ThreadSummary;
    selected: boolean;
    onSelect: () => void;
    onUpdate: (action: UpdateThreadRequest) => Promise<boolean>;
};

export function ThreadRow({
    summary,
    selected,
    onSelect,
    onUpdate,
}: ThreadRowProps) {
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(summary.title);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const running = summary.runStatus === "running";
    const archived = summary.retiredAt !== null;
    const stateLabel = running
        ? "Running"
        : summary.runStatus === "failed"
          ? "Failed"
          : summary.runStatus === "cancelled"
            ? "Stopped"
            : "Completed";
    const description = `${summary.title} — ${archived ? "Archived, " : ""}${stateLabel}${running && !archived ? ". Stop or wait for the run to finish before archiving." : ""}`;
    const actionClassName =
        "rounded-[6px] hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground aria-expanded:bg-transparent dark:hover:bg-sidebar-foreground/5 [@media(pointer:coarse)]:size-11";

    async function update(action: UpdateThreadRequest) {
        setBusy(true);
        setError(null);
        let ok = false;
        try {
            ok = await onUpdate(action);
        } catch (error) {
            setBusy(false);
            setError(
                error instanceof Error
                    ? error.message
                    : "Could not update thread.",
            );
            return;
        }
        setBusy(false);
        if (!ok) {
            setError(
                action.action === "archive" && running
                    ? "This thread is busy. Stop or wait for the run to finish."
                    : "Could not update this thread. Try again.",
            );
            return;
        }
        setEditing(false);
    }

    return (
        <SidebarMenuSubItem>
            {editing ? (
                <form
                    className="flex min-h-8 min-w-0 items-center gap-1 px-2 py-1 [@media(pointer:coarse)]:min-h-11"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void update({ action: "rename", title });
                    }}
                >
                    <label className="sr-only" htmlFor={`rename-${summary.id}`}>
                        Rename {summary.title}
                    </label>
                    <input
                        id={`rename-${summary.id}`}
                        autoFocus
                        className="min-w-0 flex-1 rounded border bg-background px-1.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={title}
                        maxLength={80}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                    <Button
                        size="icon-xs"
                        className={actionClassName}
                        variant="ghost"
                        type="submit"
                        disabled={busy || title.trim().length === 0}
                        aria-label={`Save name for ${summary.title}`}
                    >
                        <Check />
                    </Button>
                    <Button
                        size="icon-xs"
                        className={actionClassName}
                        variant="ghost"
                        type="button"
                        onClick={() => setEditing(false)}
                        aria-label="Cancel rename"
                    >
                        <X />
                    </Button>
                </form>
            ) : (
                <div
                    className={`flex h-8 min-w-0 items-center rounded-[6px] pr-2 hover:bg-sidebar-foreground/5 has-focus-visible:bg-sidebar-foreground/5 [@media(pointer:coarse)]:h-11 ${selected ? "bg-sidebar-foreground/10" : ""}`}
                >
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <SidebarMenuSubButton
                                    className="h-8 flex-1 translate-x-0 gap-1.5 rounded-[6px] px-2 text-left hover:bg-transparent active:bg-transparent data-active:bg-transparent hover:text-sidebar-foreground active:text-sidebar-foreground data-active:text-sidebar-foreground [@media(pointer:coarse)]:h-11"
                                    render={
                                        <button
                                            type="button"
                                            onClick={onSelect}
                                        />
                                    }
                                    isActive={selected}
                                    aria-current={selected ? "page" : undefined}
                                    aria-label={`Open thread ${description}`}
                                />
                            }
                        >
                            <span className="min-w-0 flex-1 truncate text-left">
                                {summary.title}
                            </span>
                            {(running ||
                                archived ||
                                summary.runStatus === "failed" ||
                                summary.runStatus === "cancelled") && (
                                <span
                                    className="flex shrink-0 items-center gap-1 text-muted-foreground"
                                    aria-hidden="true"
                                >
                                    {running && (
                                        <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
                                    )}
                                    {!running &&
                                        summary.runStatus === "failed" && (
                                            <CircleAlert className="size-3.5" />
                                        )}
                                    {!running &&
                                        summary.runStatus === "cancelled" && (
                                            <CircleStop className="size-3.5" />
                                        )}
                                    {archived && (
                                        <Archive className="size-3.5" />
                                    )}
                                </span>
                            )}
                        </TooltipTrigger>
                        <TooltipContent
                            className="[overflow-wrap:anywhere]"
                            side="bottom"
                            align="start"
                            sideOffset={8}
                        >
                            {description}
                        </TooltipContent>
                    </Tooltip>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100">
                        <Button
                            size="icon-xs"
                            className={actionClassName}
                            variant="ghost"
                            type="button"
                            onClick={() => {
                                setTitle(summary.title);
                                setEditing(true);
                            }}
                            aria-label={`Rename ${summary.title}`}
                        >
                            <Pencil />
                        </Button>
                        <Button
                            size="icon-xs"
                            className={actionClassName}
                            variant="ghost"
                            type="button"
                            disabled={busy || (running && !archived)}
                            title={
                                running && !archived
                                    ? "Wait for the run to finish or stop it before archiving."
                                    : undefined
                            }
                            onClick={() =>
                                void update({
                                    action: archived ? "restore" : "archive",
                                })
                            }
                            aria-label={
                                archived
                                    ? `Restore ${summary.title}`
                                    : `Archive ${summary.title}`
                            }
                        >
                            {archived ? <RotateCcw /> : <Archive />}
                        </Button>
                    </div>
                </div>
            )}
            {error !== null && (
                <p
                    role="alert"
                    className="px-2 pb-1 text-[10px] text-destructive"
                >
                    {error}
                </p>
            )}
        </SidebarMenuSubItem>
    );
}
