import type {
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { HarnessEvent } from "../contract";
import { clip, object, string } from "../json";

const VERBS: Partial<Record<ToolKind, string>> = {
  edit: "Edit",
  read: "Read",
  delete: "Delete",
  move: "Move",
  search: "Search",
  fetch: "Fetch",
};

const FILE_KINDS = new Set<ToolKind>(["edit", "read", "delete", "move"]);

/** A tool's shareable one-line summary from its title and kind. */
export function toolSummary(title: string, kind?: ToolKind | null) {
  const line = clip(title.replace(/\s+/g, " ").trim() || "a tool", 200);
  const verb = kind && VERBS[kind];
  return verb && !line.startsWith(verb) ? `${verb} ${line}` : line;
}

/** Text and diffs a tool reported, kept as local-only detail. */
export function toolDetail(content: ToolCallContent[] | null | undefined) {
  const parts = (content ?? []).flatMap((item) => {
    if (item.type === "content" && item.content.type === "text")
      return [item.content.text];
    if (item.type === "diff")
      return [
        `${item.path}\n--- before\n${item.oldText ?? ""}\n+++ after\n${item.newText}`,
      ];
    return [];
  });
  return parts.length ? clip(parts.join("\n\n"), 20_000) : undefined;
}

/**
 * Maps one turn's ACP session updates onto tab events. Assistant text starts a new item after
 * each tool call, so the transcript keeps the order the model worked in.
 */
export class TurnEvents {
  private segment = 0;
  private tools = new Map<
    string,
    { title: string; kind?: ToolKind; detail?: string }
  >();

  constructor(private turn: string) {}

  map(update: SessionUpdate): HarnessEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text" || !update.content.text) return [];
        const reasoning = update.sessionUpdate === "agent_thought_chunk";
        return [
          {
            type: "text",
            item: `${this.turn}-${reasoning ? "thought" : "message"}-${this.segment}`,
            kind: reasoning ? "reasoning" : "assistant",
            delta: update.content.text,
          },
        ];
      }
      case "tool_call":
      case "tool_call_update": {
        const known = this.tools.get(update.toolCallId);
        if (!known) this.segment++;
        // File tools are titled by their tool name; the path they touch says more.
        const path = FILE_KINDS.has(update.kind ?? known?.kind ?? "other")
          ? update.locations?.[0]?.path
          : undefined;
        const tool = {
          title: path || string(update.title) || known?.title || "",
          kind: update.kind ?? known?.kind ?? undefined,
          detail: toolDetail(update.content) ?? known?.detail,
        };
        this.tools.set(update.toolCallId, tool);
        const failed = update.status === "failed";
        return [
          {
            type: "tool",
            item: update.toolCallId,
            summary: `${toolSummary(tool.title, tool.kind)}${failed ? " (failed)" : ""}`,
            ...(tool.detail ? { detail: tool.detail } : {}),
          },
        ];
      }
      default:
        return [];
    }
  }
}

/** Whether a permission request is for access outside the checkout (`external_directory`). */
export function outsideCheckout(toolCall: {
  kind?: ToolKind | null;
  rawInput?: unknown;
}) {
  const input = object(toolCall.rawInput);
  return (
    toolCall.kind !== "execute" &&
    toolCall.kind !== "edit" &&
    (typeof input.parentDir === "string" || Array.isArray(input.directories))
  );
}
