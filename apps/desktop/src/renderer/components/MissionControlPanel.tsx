import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  ClipboardList,
  Radio,
} from "lucide-react";
import type { Room, Suggestion } from "../../shared/contracts";
import {
  HARNESS_LABELS,
  type HarnessState,
  type PlanStep,
  type Tab,
} from "../../shared/tabs";
import { plural } from "../lib/utils";
import { AgentTasks } from "./AgentTasks";
import { SuggestionColumn } from "./SuggestionColumn";
import { Button } from "./ui/Button";
import { STATUS_LABELS } from "./tabs/labels";

const STEP_ICONS: Record<PlanStep["status"], typeof Circle> = {
  pending: Circle,
  active: CircleDot,
  done: CheckCircle2,
};
const STEP_LABELS: Record<PlanStep["status"], string> = {
  pending: "Pending",
  active: "In progress",
  done: "Done",
};

function LeadContext({
  tab,
  harness,
}: {
  tab: Tab | undefined;
  harness: HarnessState | undefined;
}) {
  const model =
    harness?.models.find((item) => item.id === tab?.loadout.model)?.name ??
    tab?.loadout.model;
  const steps = tab?.plan?.steps ?? [];
  return (
    <section className="mission-column" aria-label="Lead context">
      <h3>
        <ClipboardList size={14} />
        Lead context{tab && <span>{STATUS_LABELS[tab.status]}</span>}
      </h3>
      <div className="mission-scroll">
        {!tab ? (
          <div className="column-empty">
            <p>Open a chat tab to follow its lead here.</p>
          </div>
        ) : (
          <div className="summary-content">
            <dl className="lead-facts">
              <div>
                <dt>Harness</dt>
                <dd>{HARNESS_LABELS[tab.loadout.harness]}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{model || "Not chosen"}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{tab.loadout.planMode ? "Plan" : "Act"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{STATUS_LABELS[tab.status]}</dd>
              </div>
            </dl>
            <span className="eyebrow">Plan</span>
            {steps.length ? (
              <>
                {tab.plan?.explanation && <p>{tab.plan.explanation}</p>}
                <ol className="lead-steps" aria-label="Lead plan">
                  {steps.map((step, index) => {
                    const Icon = STEP_ICONS[step.status];
                    return (
                      <li key={index} className={`step-${step.status}`}>
                        <Icon size={12} aria-label={STEP_LABELS[step.status]} />
                        <span>{step.text}</span>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <p className="subtle">
                No plan in this tab. {HARNESS_LABELS[tab.loadout.harness]} shows
                its plan here when it keeps one.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function MissionControlPanel({
  room,
  tab,
  harness,
  agentKey,
  onSelectAgent,
  onUseSuggestion,
  disabled,
  watching,
  collapsed,
  onToggle,
}: {
  room: Room;
  tab: Tab | undefined;
  harness: HarnessState | undefined;
  agentKey: string | null;
  onSelectAgent: (key: string | null) => void;
  onUseSuggestion: (suggestion: Suggestion) => void;
  disabled: boolean;
  // The shared tab filling the main area; Mission Control keeps following your own tab.
  watching?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const running = tab?.runningAgents ?? 0;
  return (
    <section className="mission-panel" aria-label="Mission Control">
      <header className="panel-header">
        <h2>
          <Radio size={16} />
          Mission Control
        </h2>
        <span className="subtle">
          {tab
            ? `${tab.title}${running ? ` · ${plural(running, "sub-agent")} running` : ""}`
            : "Follows the active chat tab"}
          {watching && ` · you are watching ${watching}`}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="mission-toggle"
          aria-label={
            collapsed ? "Expand Mission Control" : "Collapse Mission Control"
          }
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronDown size={14} />
        </Button>
      </header>
      <div className="mission-grid" hidden={collapsed}>
        <LeadContext tab={tab} harness={harness} />
        <AgentTasks
          roomId={room.id}
          tab={tab}
          harness={harness}
          agentKey={agentKey}
          onSelectAgent={onSelectAgent}
        />
        <SuggestionColumn
          room={room}
          disabled={disabled}
          onUseSuggestion={onUseSuggestion}
        />
      </div>
    </section>
  );
}
