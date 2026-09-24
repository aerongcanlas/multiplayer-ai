import { ShieldQuestion } from "lucide-react";
import type { TranscriptEntry } from "../../../shared/tabs";
import { Button } from "../ui/Button";

const outcome: Record<string, string> = {
  accepted: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

export function ApprovalCard({
  entry,
  disabled,
  onRespond,
}: {
  entry: TranscriptEntry;
  disabled: boolean;
  onRespond: (decision: "accept" | "decline") => void;
}) {
  const pending = entry.state === "pending";
  return (
    <div
      className={`approval-card ${pending ? "" : "approval-settled"}`}
      role="region"
      aria-label="Agent approval"
    >
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
