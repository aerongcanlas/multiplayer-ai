import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  ClipboardList,
  Radio,
} from "lucide-react";
import type { Room, Suggestion } from "../../shared/contracts";
import type { PlanStep } from "../../shared/tabs";
import {
  missionSubtitle,
  planNotice,
  type MissionSource,
} from "../lib/mission";
import { AgentTasks } from "./AgentTasks";
import { SuggestionColumn } from "./SuggestionColumn";
import { Button } from "./ui/Button";

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

function LeadContext({ source }: { source: MissionSource | null }) {
  return (
    <section className="mission-column" aria-label="Lead context">
      <h3>
        <ClipboardList size={14} />
        Lead context{source && <span>{source.status}</span>}
      </h3>
      <div className="mission-scroll">
        {!source ? (
          <div className="column-empty">
            <p>Open a chat tab to follow its lead here.</p>
          </div>
        ) : (
          <div className="summary-content">
            <dl className="lead-facts">
              {source.facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
            <span className="eyebrow">Plan</span>
            {source.plan.steps.length ? (
              <>
                {source.plan.explanation && <p>{source.plan.explanation}</p>}
                <ol className="lead-steps" aria-label="Lead plan">
                  {source.plan.steps.map((step, index) => {
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
              <p className="subtle">{planNotice(source)}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function MissionControlPanel({
  room,
  source,
  agentKey,
  onSelectAgent,
  onUseSuggestion,
  disabled,
  collapsed,
  onToggle,
}: {
  room: Room;
  // The tab in the main area: the member's own, or a host's shared tab, view-only.
  source: MissionSource | null;
  agentKey: string | null;
  onSelectAgent: (key: string | null) => void;
  onUseSuggestion: (suggestion: Suggestion) => void;
  disabled: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="mission-panel" aria-label="Mission Control">
      <header className="panel-header">
        <h2>
          <Radio size={16} />
          Mission Control
        </h2>
        <span className="subtle">{missionSubtitle(source)}</span>
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
        <LeadContext source={source} />
        <AgentTasks
          source={source}
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
