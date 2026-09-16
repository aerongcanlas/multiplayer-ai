import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export function ThreadWelcome({
  className,
  description = "Send a direction to start working together.",
  children,
}: {
  className?: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      aria-label="New thread welcome"
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center",
        className,
      )}
    >
      <Bot aria-hidden="true" className="size-10 text-primary" />
      <h2 className="text-xl font-semibold tracking-tight">
        A shared goal. A visible plan.
      </h2>
      <p className="max-w-sm text-sm text-white/60">{description}</p>
      {children}
    </div>
  );
}
export default ThreadWelcome;
