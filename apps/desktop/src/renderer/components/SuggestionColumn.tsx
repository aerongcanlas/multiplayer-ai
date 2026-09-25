import { Pencil, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Room, Suggestion } from "../../shared/contracts";
import { Button } from "./ui/Button";
import { timeLabel } from "../lib/time";
import { perform } from "../lib/desktop-store";
import { getStored, setStored } from "../lib/storage";
import { plural } from "../lib/utils";

const dismissedKey = (roomId: string) => `multiplayer:dismissed:${roomId}`;

/** Suggestions hidden on this desktop only; the room keeps them for everyone else. */
function useDismissed(roomId: string) {
  const [ids, setIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(getStored(dismissedKey(roomId)) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  function update(next: Set<string>) {
    setIds(next);
    setStored(dismissedKey(roomId), JSON.stringify([...next]));
  }
  return {
    ids,
    dismiss: (id: string) => update(new Set(ids).add(id)),
    restore: (id: string) => {
      const next = new Set(ids);
      next.delete(id);
      update(next);
    },
  };
}

function SuggestionCard({
  suggestion,
  roomId,
  disabled,
  canEdit,
  dismissed,
  onUse,
  onDismiss,
  onRestore,
}: {
  suggestion: Suggestion;
  roomId: string;
  disabled: boolean;
  canEdit: boolean;
  dismissed: boolean;
  onUse: (suggestion: Suggestion) => void;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(suggestion.prompt);
  const submitted = suggestion.status === "submitted";
  async function save() {
    const result = await perform(() =>
      window.desktop.editSuggestion(
        roomId,
        suggestion.id,
        draft,
        suggestion.revision,
      ),
    );
    if (result) setEditing(false);
  }
  return (
    <article
      className={`suggestion-card ${dismissed ? "suggestion-dismissed" : ""}`}
    >
      <div className="card-meta">
        <span>Edit {suggestion.revision}</span>
        <span>
          {dismissed ? "Dismissed" : submitted ? "Submitted" : "Draft"}
        </span>
      </div>
      {editing ? (
        <textarea
          className="suggestion-editor"
          aria-label="Edit suggested prompt"
          maxLength={8_000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p className="suggestion-prompt">{suggestion.prompt}</p>
      )}
      <details className="source-details">
        <summary>
          {plural(suggestion.sources.length, "attributed source message")}
        </summary>
        {suggestion.sources.map((source) => (
          <blockquote key={source.id}>
            <strong>{source.authorName}</strong>
            <p>{source.text}</p>
            <span>{timeLabel(source.createdAt)}</span>
          </blockquote>
        ))}
      </details>
      <div className="card-actions">
        {dismissed ? (
          <Button size="xs" variant="outline" onClick={onRestore}>
            <RotateCcw size={12} />
            Restore
          </Button>
        ) : editing ? (
          <>
            <Button
              size="xs"
              disabled={disabled || !draft.trim()}
              onClick={() => void save()}
            >
              Save edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(suggestion.prompt);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="xs"
              disabled={disabled || submitted}
              onClick={() => onUse(suggestion)}
            >
              Use prompt
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled || submitted || !canEdit}
              onClick={() => setEditing(true)}
            >
              <Pencil size={12} />
              Edit
            </Button>
            <Button size="xs" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

export function SuggestionColumn({
  room,
  disabled,
  onUseSuggestion,
}: {
  room: Room;
  disabled: boolean;
  onUseSuggestion: (suggestion: Suggestion) => void;
}) {
  const { ids, dismiss, restore } = useDismissed(room.id);
  const [showDismissed, setShowDismissed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const all = [...room.suggestions].reverse();
  const visible = all.filter((item) => !ids.has(item.id));
  const hidden = all.filter((item) => ids.has(item.id));
  const shown = showDismissed ? [...visible, ...hidden] : visible;
  return (
    <section className="mission-column" aria-label="Prompt suggestions">
      <h3>
        <Sparkles size={14} />
        Prompt suggestions<span>{visible.length}</span>
      </h3>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <div className="mission-scroll">
        {visible.length === 0 && !showDismissed ? (
          <div className="column-empty">
            {hidden.length > 0 ? (
              <p>All suggestions are dismissed.</p>
            ) : (
              <>
                <p>
                  Select messages in Group Chat, then choose{" "}
                  <strong>Suggest prompts</strong>.
                </p>
                <p>
                  Edit the draft and choose <strong>Use prompt</strong> to fill
                  the active tab. Send it when you’re ready.
                </p>
              </>
            )}
          </div>
        ) : (
          shown.map((suggestion) => (
            <SuggestionCard
              key={`${suggestion.id}:${suggestion.revision}`}
              suggestion={suggestion}
              roomId={room.id}
              canEdit={
                !room.shared ||
                room.shared.isAdmin ||
                suggestion.authorId === room.shared.userId
              }
              disabled={disabled}
              dismissed={ids.has(suggestion.id)}
              onUse={onUseSuggestion}
              onDismiss={() => {
                dismiss(suggestion.id);
                setAnnouncement("Suggestion dismissed.");
              }}
              onRestore={() => {
                restore(suggestion.id);
                setAnnouncement("Suggestion restored.");
              }}
            />
          ))
        )}
        {hidden.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            className="suggestion-toggle"
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed(!showDismissed)}
          >
            {showDismissed
              ? "Hide dismissed"
              : `Show ${hidden.length} dismissed`}
          </Button>
        )}
      </div>
    </section>
  );
}
