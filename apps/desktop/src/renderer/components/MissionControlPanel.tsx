import {
  CheckCircle2,
  ClipboardList,
  GitBranch,
  Pencil,
  Radio,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Execution, Room, Suggestion } from "../../shared/contracts";
import { currentSummary } from "../../shared/selectors";
import { Button } from "./ui/Button";
import { StatusBadge, durationLabel, timeLabel } from "./StatusBadge";
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
  execution,
  selectedTaskId,
  onTaskSelect,
  onUseSuggestion,
  disabled,
  stale,
}: {
  room: Room;
  execution?: Execution;
  selectedTaskId: string | null;
  onTaskSelect: (id: string | null) => void;
  onUseSuggestion: (suggestion: Suggestion) => void;
  disabled: boolean;
  stale: boolean;
}) {
  const summary = currentSummary(room);
  const complete =
    execution?.tasks.filter((task) => task.status === "completed").length ?? 0;
  const taskScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    taskScroll.current?.scrollTo({ top: 0 });
  }, [execution?.id]);
  return (
    <section className="mission-panel" aria-label="Mission Control">
      <header className="panel-header">
        <h2>
          <Radio size={16} />
          Mission Control
        </h2>
        <span className="subtle">
          {execution
            ? `${complete} of ${execution.tasks.length} tasks completed · Plan v${execution.planVersion}`
            : "Ready for your first direction"}
        </span>
      </header>
      <div className="mission-grid">
        <section className="mission-column" aria-label="Lead context">
          <h3>
            <ClipboardList size={14} />
            Lead context<span>{summary ? `v${summary.version}` : "v0"}</span>
          </h3>
          <div className="mission-scroll">
            {summary ? (
              <div className="summary-content">
                <span className="eyebrow">Goal</span>
                <p className="summary-goal">{summary.goal}</p>
                <span className="eyebrow">Current work</span>
                <p>{summary.currentWork}</p>
                <span className="eyebrow">Decisions</span>
                <ul>
                  {summary.decisions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <span className="eyebrow">Open questions</span>
                {summary.questions.map((item) => (
                  <p key={item}>{item}</p>
                ))}
                <details>
                  <summary>Uncertainties</summary>
                  {summary.uncertainties.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </details>
              </div>
            ) : (
              <div className="column-empty">
                <p>The lead’s summary will appear here after an execution.</p>
                <p>
                  Goals, decisions, evidence, and open questions stay tied to a
                  context version.
                </p>
              </div>
            )}
          </div>
        </section>
        <section className="mission-column" aria-label="Agent task tree">
          <h3>
            <GitBranch size={14} />
            Agent tasks{execution && <span>{execution.tasks.length}</span>}
          </h3>
          <div className="mission-scroll" ref={taskScroll}>
            {execution ? (
              <>
                <div className="task-tree">
                  {execution.tasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      className={`task-row ${task.parentId ? "task-child" : ""} ${selectedTaskId === task.id ? "task-selected" : ""}`}
                      aria-pressed={selectedTaskId === task.id}
                      onClick={() =>
                        onTaskSelect(
                          selectedTaskId === task.id ? null : task.id,
                        )
                      }
                    >
                      <div className="task-heading">
                        <strong>{task.role}</strong>
                        <StatusBadge status={task.status} stale={stale} />
                      </div>
                      <p>{task.objective}</p>
                      <span className="task-activity">{task.activity}</span>
                      <span className="task-time">
                        {task.startedAt
                          ? durationLabel(
                              task.startedAt,
                              task.completedAt ?? task.updatedAt,
                            )
                          : "Queued"}{" "}
                        · {timeLabel(task.updatedAt)}
                      </span>
                    </button>
                  ))}
                </div>
                {execution.evidence
                  .filter((item) => item.kind !== "command")
                  .map((item) => (
                    <div
                      key={item.id}
                      className={`evidence evidence-${item.outcome}`}
                    >
                      {item.outcome === "passed" ? (
                        <CheckCircle2 size={14} />
                      ) : (
                        <XCircle size={14} />
                      )}
                      <div>
                        <strong>
                          {item.kind === "simulation"
                            ? "Simulated validation"
                            : item.label}{" "}
                          {item.outcome}
                        </strong>
                        <details>
                          <summary>Evidence</summary>
                          <p>{item.detail}</p>
                        </details>
                        <span>Revision {item.revision.slice(0, 8)}</span>
                      </div>
                    </div>
                  ))}
                {execution.evidence.some((item) => item.kind === "command") && (
                  <details className="command-evidence">
                    <summary>
                      {
                        execution.evidence.filter(
                          (item) => item.kind === "command",
                        ).length
                      }{" "}
                      command results
                    </summary>
                    {execution.evidence
                      .filter((item) => item.kind === "command")
                      .map((item) => (
                        <details
                          className={`evidence evidence-${item.outcome}`}
                          key={item.id}
                        >
                          <summary>
                            {item.label}: {item.outcome}
                          </summary>
                          <pre>{item.detail}</pre>
                        </details>
                      ))}
                  </details>
                )}
                {execution.artifact && (
                  <details className="artifact">
                    <summary>
                      Review patch · {execution.artifact.files.length} files
                    </summary>
                    <p>{execution.artifact.branch}</p>
                    <pre>{execution.artifact.diff || "No file changes."}</pre>
                  </details>
                )}
              </>
            ) : (
              <div className="column-empty">
                <p>Watch each agent’s assignment and latest activity here.</p>
                <p>Select an agent to inspect its detailed activity above.</p>
              </div>
            )}
          </div>
        </section>
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
                  the composer. Send it when you’re ready.
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
