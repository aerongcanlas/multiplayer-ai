import { Bot } from "lucide-react";

/** Names the sub-agent that asked, on requests waiting in the lead's view. */
export function SubAgentBadge({ name }: { name: string }) {
  return (
    <span className="card-agent">
      <Bot size={12} />
      Sub-agent · {name}
    </span>
  );
}
