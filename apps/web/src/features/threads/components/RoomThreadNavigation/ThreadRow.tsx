"use client";

import type {
    ThreadSummary,
    UpdateThreadRequest,
} from "@multiplayer-ai/domain";
import {
    Archive,
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
                    className="flex items-center gap-1 px-1 py-1"
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
                        variant="ghost"
                        type="submit"
                        disabled={busy || title.trim().length === 0}
                        aria-label={`Save name for ${summary.title}`}
                    >
                        <Check />
                    </Button>
                    <Button
                        size="icon-xs"
                        variant="ghost"
                        type="button"
                        onClick={() => setEditing(false)}
                        aria-label="Cancel rename"
                    >
                        <X />
                    </Button>
                </form>
            ) : (
                <SidebarMenuSubButton
                    render={<button type="button" onClick={onSelect} />}
                    isActive={selected}
                    aria-current={selected ? "page" : undefined}
                    aria-label={`Open thread ${summary.title}`}
                >
                    {running && (
                        <LoaderCircle
                            className="animate-spin"
                            aria-hidden="true"
                        />
                    )}
                    {!running && archived && <Archive aria-hidden="true" />}
                    <span>{summary.title}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                        {running
                            ? "Running"
                            : summary.runStatus === "failed"
                              ? "Failed"
                              : summary.runStatus === "cancelled"
                                ? "Stopped"
                                : "Completed"}
                    </span>
                </SidebarMenuSubButton>
            )}
            <div className="absolute top-0.5 right-0 flex items-center gap-0.5 bg-sidebar opacity-0 transition-opacity group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100">
                {!editing && (
                    <>
                        <Button
                            size="icon-xs"
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
                    </>
                )}
            </div>
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
