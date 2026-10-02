import { Pencil, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Room, Suggestion } from "../../shared/contracts";
import { Button } from "./ui/Button";
import { timeLabel } from "../lib/time";
import { perform } from "../lib/desktop-store";
import { plural } from "../lib/utils";

function SuggestionCard({
  suggestion,
  roomId,
  disabled,
  canEdit,
  onUse,
  onDeleted,
}: {
  suggestion: Suggestion;
  roomId: string;
  disabled: boolean;
  canEdit: boolean;
  onUse: (suggestion: Suggestion) => void;
  onDeleted: () => void;
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
    <article className="suggestion-card">
      <div className="card-meta">
        <span>Edit {suggestion.revision}</span>
        <span>{submitted ? "Submitted" : "Draft"}</span>
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
        {editing ? (
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
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled || !canEdit}
              title={
                canEdit
                  ? "Delete this suggestion from the room"
                  : "Only the author or a room admin can delete this suggestion"
              }
              onClick={() =>
                void perform(() =>
                  window.desktop.deleteSuggestion(roomId, suggestion.id),
                ).then((result) => result && onDeleted())
              }
            >
              <Trash2 size={12} />
              Delete
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
  const [announcement, setAnnouncement] = useState("");
  const shown = [...room.suggestions].reverse();
  return (
    <section className="mission-column" aria-label="Prompt suggestions">
      <h3>
        <Sparkles size={14} />
        Prompt suggestions<span>{shown.length}</span>
      </h3>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <div className="mission-scroll">
        {shown.length === 0 ? (
          <div className="column-empty">
            <p>
              Select messages in Group Chat, then choose{" "}
              <strong>Suggest prompts</strong>.
            </p>
            <p>
              Edit the draft and choose <strong>Use prompt</strong> to fill the
              active tab. Send it when you’re ready.
            </p>
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
              onUse={onUseSuggestion}
              onDeleted={() => setAnnouncement("Suggestion deleted.")}
            />
          ))
        )}
      </div>
    </section>
  );
}
