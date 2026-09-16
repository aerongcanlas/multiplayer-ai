import { ThreadWelcome } from "@multiplayer-ai/ui/ai/thread-welcome";
import { useChatScroll } from "@multiplayer-ai/ui/hooks/use-chat-scroll";
import { Bot, CircleStop, FlaskConical, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { Execution, Room, Suggestion } from "../../shared/contracts";
import { Button } from "./ui/Button";
import { PromptInput } from "./PromptInput";
import { StatusBadge, timeLabel } from "./StatusBadge";
import { perform } from "../lib/desktop-store";

interface Props {
  room: Room;
  execution?: Execution;
  taskId: string | null;
  onTaskSelect: (id: string | null) => void;
  onExecutionSelect: (id: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  source: Suggestion | null;
  onSourceClear: () => void;
  scenario: "success" | "validation-failure";
  onScenarioChange: (value: "success" | "validation-failure") => void;
  onSubmit: (text: string) => Promise<boolean>;
  disabled: boolean;
  active: boolean;
  stale: boolean;
  runner: "mock" | "codex";
  ready: boolean;
  controls: ReactNode;
}

export function AIActivityPanel({
  room,
  execution,
  taskId,
  onTaskSelect,
  onExecutionSelect,
  draft,
  onDraftChange,
  source,
  onSourceClear,
  scenario,
  onScenarioChange,
  onSubmit,
  disabled,
  active,
  stale,
  runner,
  ready,
  controls,
}: Props) {
  const { containerRef: scroll, scrollToBottom } = useChatScroll();
  const visibleEvents =
    execution?.events.filter((event) => !taskId || event.taskId === taskId) ??
    [];
  const task = execution?.tasks.find((task) => task.id === taskId);
  useEffect(scrollToBottom, [execution?.events.length, taskId, scrollToBottom]);
  return (
    <section className="panel activity-panel" aria-label="AI activity">
      <header className="panel-header">
        <h2>
          <Bot size={16} />
          AI activity
        </h2>
        <div className="header-actions">
          {execution?.status === "running" && (
            <Button
              size="xs"
              variant="outline"
              disabled={stale}
              onClick={() =>
                void perform(() =>
                  window.desktop.stopExecution(room.id, execution.id),
                )
              }
            >
              <CircleStop size={13} />
              Stop
            </Button>
          )}
          <span className="mode-badge">
            {(execution?.runner ?? runner) === "codex" ? (
              <Bot size={12} />
            ) : (
              <FlaskConical size={12} />
            )}
            {(execution?.runner ?? runner) === "codex"
              ? "Codex · ChatGPT"
              : "Mock runner"}
          </span>
        </div>
      </header>
      {room.executions.length > 0 && (
        <div className="activity-toolbar">
          <select
            aria-label="Execution history"
            value={execution?.id ?? ""}
            onChange={(event) => onExecutionSelect(event.target.value)}
          >
            {room.executions.map((run, index) => (
              <option key={run.id} value={run.id}>
                Run {index + 1} · {run.prompt.slice(0, 42)}
              </option>
            ))}
          </select>
          {execution && <StatusBadge status={execution.status} stale={stale} />}
        </div>
      )}
      {task && (
        <div className="activity-filter">
          <span>Showing {task.role} activity</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Show all agent activity"
            onClick={() => onTaskSelect(null)}
          >
            <X size={12} />
          </Button>
        </div>
      )}
      <div className="panel-scroll activity-events" ref={scroll}>
        {!execution ? (
          <ThreadWelcome
            className="h-full py-6"
            description="Select a repository, then send a direction to see the lead coordinate specialist tasks."
          >
            <span className="subtle">
              {runner === "codex"
                ? "Your ChatGPT allowance powers the lead and specialists."
                : "The mock runner demonstrates progress without changing files."}
            </span>
          </ThreadWelcome>
        ) : (
          <>
            <div className="direction-card">
              <span className="eyebrow">Your direction</span>
              <p>{execution.prompt}</p>
            </div>
            {visibleEvents.map((event) => {
              const role =
                execution.tasks.find((task) => task.id === event.taskId)
                  ?.role ?? "lead";
              return (
                <article
                  className={`activity-event event-${event.type}`}
                  key={event.id}
                >
                  <div className={`agent-avatar role-${role}`}>
                    {role.charAt(0).toUpperCase()}
                  </div>
                  <div className="event-body">
                    <div className="event-meta">
                      <strong>{role}</strong>
                      <span>
                        {timeLabel(event.createdAt)} · #{event.seq}
                      </span>
                    </div>
                    <p>{event.message}</p>
                  </div>
                </article>
              );
            })}
            {execution.status === "blocked" && (
              <p className="inline-warning">
                This execution was interrupted. Review the saved activity before
                submitting another direction.
              </p>
            )}
          </>
        )}
      </div>
      <div className="panel-composer">
        {execution?.approvals?.map((approval) => (
          <div
            className="approval-card"
            key={approval.id}
            role="region"
            aria-label="Agent approval"
          >
            <strong>{approval.title}</strong>
            <pre>{approval.detail}</pre>
            <div>
              <Button
                size="xs"
                disabled={stale}
                onClick={() =>
                  void perform(() =>
                    window.desktop.respondToApproval(
                      room.id,
                      execution.id,
                      approval.id,
                      "accept",
                    ),
                  )
                }
              >
                Approve once
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={stale}
                onClick={() =>
                  void perform(() =>
                    window.desktop.respondToApproval(
                      room.id,
                      execution.id,
                      approval.id,
                      "decline",
                    ),
                  )
                }
              >
                Decline
              </Button>
            </div>
          </div>
        ))}
        {controls}
        {source && (
          <div className="source-chip">
            <span>
              {source.sources.length} source{" "}
              {source.sources.length === 1 ? "message" : "messages"} · Context v
              {source.contextVersion}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Detach suggestion"
              onClick={onSourceClear}
            >
              <X size={12} />
            </Button>
          </div>
        )}
        <PromptInput
          targetKey={room.id}
          label="Agent direction"
          placeholder={
            room.workspace
              ? "What should the lead work on?"
              : "Select a repository to get started..."
          }
          submitLabel={runner === "codex" ? "Run agents" : "Run simulation"}
          value={draft}
          onChange={onDraftChange}
          disabled={disabled || active || !room.workspace || !ready}
          onSubmit={onSubmit}
          footer={
            runner === "mock" ? (
              <label className="scenario-label">
                Scenario{" "}
                <select
                  aria-label="Mock scenario"
                  disabled={active || disabled}
                  value={scenario}
                  onChange={(event) =>
                    onScenarioChange(event.target.value as Props["scenario"])
                  }
                >
                  <option value="success">Success</option>
                  <option value="validation-failure">Validation failure</option>
                </select>
              </label>
            ) : undefined
          }
        />
        <p className="composer-hint">
          {runner === "codex"
            ? "Uses your ChatGPT allowance · Work runs on this desktop"
            : "Simulation only · No model charges · No repository changes"}
        </p>
      </div>
    </section>
  );
}
