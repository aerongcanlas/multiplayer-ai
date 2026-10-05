import {
  newerVersion,
  type HarnessId,
  type HarnessModel,
  type HarnessState,
  type LocalServer,
} from "../../shared/tabs";
import { plural } from "./utils";

export const programFailed = (program: HarnessState["program"]) =>
  ["failed", "custom_invalid", "unsupported"].includes(program.state);

const percent = (program: HarnessState["program"]) =>
  `${Math.round((program.progress ?? 0) * 100)}%`;

export function programLabel({ program }: HarnessState) {
  switch (program.state) {
    case "ready":
      return `Managed ${program.version ?? program.pinned}`;
    case "custom":
      return `Custom executable${program.version ? ` · ${program.version}` : ""}`;
    case "downloading":
      return `Downloading ${program.pinned}… ${percent(program)}`;
    case "missing":
      return `Downloads ${program.pinned} on first use`;
    case "failed":
      return "Download failed";
    case "custom_invalid":
      return "Custom executable unusable";
    case "unsupported":
      return "No managed build for this platform";
    default:
      return "Checking program…";
  }
}

// What "signed out" means for each harness: OpenCode is ready once any model is usable.
const SIGNED_OUT: Record<HarnessId, { label: string; readiness: string }> = {
  codex: { label: "Not signed in", readiness: "Sign in required" },
  claude: { label: "Not signed in", readiness: "Sign in required" },
  opencode: {
    label: "No models available",
    readiness: "No models available",
  },
};

export function authLabel({ id, auth }: HarnessState) {
  if (auth.state === "signed_in")
    return `${auth.account ?? "Signed in"}${auth.plan ? ` · ${auth.plan}` : ""}`;
  if (auth.state === "signed_out") return SIGNED_OUT[id].label;
  if (auth.state === "signing_in") return "Finish signing in in your browser";
  if (auth.state === "checking") return "Checking sign-in…";
  return "Sign-in not checked yet";
}

type AccountAction = "sign_in" | "cancel" | "sign_out" | "command";

/**
 * The sign-in controls a harness offers now (R6, R7): Cancel while signing in, Sign in when an
 * in-app harness is signed out, a copy-ready command for terminal sign-ins, and Sign out only
 * while the app holds a login of its own.
 */
export function accountActions({
  signIn,
  auth,
}: HarnessState): AccountAction[] {
  if (auth.state === "signing_in") return ["cancel"];
  const actions: AccountAction[] = [];
  if (signIn === "in_app" && auth.state === "signed_out")
    actions.push("sign_in");
  if (signIn === "command" && auth.command) actions.push("command");
  if (auth.signOut) actions.push("sign_out");
  return actions;
}

/** One line telling whether a harness can start a tab right away. */
export function readiness(harness: HarnessState | undefined) {
  if (!harness) return { ready: false, text: "Checking…" };
  const { program, auth } = harness;
  if (programFailed(program))
    return { ready: false, text: "Program needs attention" };
  if (program.state === "downloading")
    return { ready: false, text: `Downloading… ${percent(program)}` };
  if (auth.state === "signed_out")
    return { ready: false, text: SIGNED_OUT[harness.id].readiness };
  if (program.state === "missing")
    return { ready: true, text: "Installs on first use" };
  const models = harness.models.length;
  return {
    ready: true,
    text: models ? `Ready · ${plural(models, "model")}` : "Ready",
  };
}

/** The newer published version a harness program is behind, and whether the app can fetch it. */
export function updateAvailable({ program, latestVersion }: HarnessState) {
  const custom = program.state === "custom";
  const current = custom ? program.version : program.pinned;
  // Versions report as "codex-cli 0.154.0" or "2.1.280 (Claude Code)".
  const running = current?.match(/\d+\.\d+\.\d+/)?.[0];
  if (!latestVersion || !running || !newerVersion(latestVersion, running))
    return null;
  return {
    version: latestVersion,
    // A custom executable is the host's to update; a download in flight finishes first.
    installable: ["ready", "missing", "failed"].includes(program.state),
  };
}

/** One line for a local model server, such as "Ollama · 3 models". */
export function serverLine(server: LocalServer) {
  if (!server.running) return `${server.label} · not running`;
  if (!server.models.length) return `${server.label} · no tool-capable models`;
  return `${server.label} · ${plural(server.models.length, "model")}`;
}

const PROVIDERS: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  opencode: "OpenCode",
};

/** Models grouped by their provider prefix (`ollama/…`); one unlabeled group when unprefixed. */
export function modelGroups(models: HarnessModel[]) {
  const groups = new Map<string, HarnessModel[]>();
  for (const model of models) {
    const slash = model.id.indexOf("/");
    const provider = slash > 0 ? model.id.slice(0, slash) : "";
    groups.set(provider, [...(groups.get(provider) ?? []), model]);
  }
  return [...groups].map(([provider, items]) => ({
    provider,
    label: provider ? (PROVIDERS[provider] ?? provider) : null,
    models: items,
  }));
}
