import { Bot, ShieldQuestion } from "lucide-react";
import type { TranscriptEntry } from "../../../shared/tabs";
import { Button } from "../ui/Button";

const outcome: Record<string, string> = {
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
  onRespond: (decision: "accept" | "decline") => void;
}) {
  const pending = entry.state === "pending";
  return (
    <div
      className={`approval-card ${pending ? "" : "approval-settled"}`}
      role="region"
      aria-label={agent ? `Approval for sub-agent ${agent}` : "Agent approval"}
    >
      {agent && (
        <span className="card-agent">
          <Bot size={12} />
          Sub-agent · {agent}
        </span>
      )}
      <strong>
        <ShieldQuestion size={13} />
        {entry.summary}
      </strong>
      {entry.detail && <pre>{entry.detail}</pre>}
      {pending ? (
        <div>
          <Button
            size="xs"
            disabled={disabled}
            onClick={() => onRespond("accept")}
          >
            Approve once
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onRespond("decline")}
          >
            Decline
          </Button>
        </div>
      ) : (
        <span className="subtle">{outcome[entry.state ?? ""] ?? ""}</span>
      )}
    </div>
  );
}
