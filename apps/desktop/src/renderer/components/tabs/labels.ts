import type { AgentStatus, TabStatus } from "../../../shared/tabs";

export const STATUS_LABELS: Record<TabStatus, string> = {
  unavailable: "Needs setup",
  idle: "Ready",
  running: "Running",
  awaiting_host: "Waiting for you",
  error: "Error",
  interrupted: "Interrupted",
  resume_failed: "Session lost",
};

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};
