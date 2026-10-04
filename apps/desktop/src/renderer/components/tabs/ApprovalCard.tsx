import { ShieldQuestion } from "lucide-react";
import type { ApprovalDecision, TranscriptEntry } from "../../../shared/tabs";
import { useDesktop } from "../../lib/desktop-store";
import { Button } from "../ui/Button";
import { responseKey } from "./labels";
import { SubAgentBadge } from "./SubAgentBadge";

const outcome: Partial<Record<NonNullable<TranscriptEntry["state"]>, string>> =
  {
    accepted: "Approved",
    declined: "Declined",
    cancelled: "Cancelled",
  };

export function ApprovalCard({
  entry,
  agent,
  disabled,
  onRespond,
}: {
  entry: TranscriptEntry;
  // The sub-agent that asked, when it was not the lead.
  agent?: string;
  disabled: boolean;
  onRespond: (decision: ApprovalDecision) => void;
}) {
  const pending = entry.state === "pending";
  const sending = useDesktop().busy.has(responseKey(entry.id));
  return (
    <div
      className={`approval-card ${pending ? "" : "approval-settled"}`}
      role="region"
      aria-label={agent ? `Approval for sub-agent ${agent}` : "Agent approval"}
    >
      {agent && <SubAgentBadge name={agent} />}
      <strong>
        <ShieldQuestion size={13} />
        {entry.summary}
      </strong>
      {entry.detail && <pre>{entry.detail}</pre>}
      {pending ? (
        <div>
          <Button
            size="xs"
            disabled={disabled || sending}
            onClick={() => onRespond("accept")}
          >
            Approve once
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || sending}
            onClick={() => onRespond("decline")}
          >
            Decline
          </Button>
        </div>
      ) : (
        <span className="subtle">
          {(entry.state && outcome[entry.state]) ?? ""}
        </span>
      )}
    </div>
  );
}
