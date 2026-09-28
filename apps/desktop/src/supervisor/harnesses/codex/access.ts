import type { Loadout } from "../../../shared/tabs";
import type { AskForApproval } from "./generated/v2/AskForApproval";
import type { SandboxMode } from "./generated/v2/SandboxMode";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy";

const ask = {
  approvalPolicy: "on-request" as AskForApproval,
  approvalsReviewer: "user" as const,
};
/** The tab's access mode replaces the host's Codex sandbox and approval settings. */
export function accessSettings(loadout: Loadout, cwd: string) {
  if (loadout.planMode || loadout.access === "ask")
    return {
      ...ask,
      sandbox: "read-only" as SandboxMode,
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      } as SandboxPolicy,
    };
  return {
    approvalPolicy: "never" as AskForApproval,
    sandbox: "workspace-write" as SandboxMode,
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    } as SandboxPolicy,
  };
}
