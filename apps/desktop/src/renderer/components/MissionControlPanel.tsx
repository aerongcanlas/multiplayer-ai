import { Pencil, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Room, Suggestion } from "../../shared/contracts";
import { currentSummary } from "../../shared/selectors";
import { Button } from "./ui/Button";
import { timeLabel } from "./StatusBadge";
import { perform } from "../lib/desktop-store";

function SuggestionCard({
  suggestion,
  roomId,
  contextVersion,
  disabled,
  canEdit,
  onUse,
}: {
  suggestion: Suggestion;
  roomId: string;
  contextVersion: number;
  disabled: boolean;
  canEdit: boolean;
  onUse: (suggestion: Suggestion) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(suggestion.prompt);
  const stale = suggestion.contextVersion !== contextVersion;
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
        <span>
          Context v{suggestion.contextVersion} · edit {suggestion.revision}
        </span>
        <span>
          {submitted ? "Submitted" : stale ? "Older context" : "Draft"}
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
          {suggestion.sources.length} attributed source{" "}
          {suggestion.sources.length === 1 ? "message" : "messages"}
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
              disabled={disabled || submitted || stale}
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
          </>
        )}
      </div>
      {stale && !submitted && (
        <p className="subtle">
          Select the source messages again to use the current context.
        </p>
      )}
    </article>
  );
}

export function MissionControlPanel({
  room,
  onUseSuggestion,
  disabled,
}: {
  room: Room;
  onUseSuggestion: (suggestion: Suggestion) => void;
  disabled: boolean;
}) {
  const summary = currentSummary(room);
  return (
    <section className="mission-panel" aria-label="Mission Control">
      <header className="panel-header">
        <h2>
          <Sparkles size={16} />
          Prompt suggestions
        </h2>
        <span className="subtle">
          Use a suggestion to fill the active tab&apos;s composer.
        </span>
      </header>
      <div className="mission-grid mission-grid-single">
        <section className="mission-column" aria-label="Prompt suggestions">
          <h3>
            <Sparkles size={14} />
            Prompt suggestions<span>{room.suggestions.length}</span>
          </h3>
          <div className="mission-scroll">
            {room.suggestions.length === 0 ? (
              <div className="column-empty">
                <p>
                  Select messages in Group Chat, then choose{" "}
                  <strong>Suggest prompts</strong>.
                </p>
                <p>
                  Edit the draft and choose <strong>Use prompt</strong> to fill
                  the active tab. Send it when you’re ready.
                </p>
              </div>
            ) : (
              [...room.suggestions]
                .reverse()
                .map((suggestion) => (
                  <SuggestionCard
                    key={`${suggestion.id}:${suggestion.revision}`}
                    suggestion={suggestion}
                    roomId={room.id}
                    contextVersion={room.shared ? 0 : (summary?.version ?? 0)}
                    canEdit={
                      !room.shared ||
                      room.shared.isAdmin ||
                      suggestion.authorId === room.shared.userId
                    }
                    disabled={disabled}
                    onUse={onUseSuggestion}
                  />
                ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
