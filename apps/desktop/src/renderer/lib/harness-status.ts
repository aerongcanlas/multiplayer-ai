import type { HarnessState } from "../../shared/tabs";
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

export function authLabel({ auth }: HarnessState) {
  if (auth.state === "signed_in")
    return `${auth.account ?? "Signed in"}${auth.plan ? ` · ${auth.plan}` : ""}`;
  if (auth.state === "signed_out") return "Not signed in";
  if (auth.state === "signing_in") return "Finish signing in in your browser";
  if (auth.state === "checking") return "Checking sign-in…";
  return "Sign-in not checked yet";
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
    return { ready: false, text: "Sign in required" };
  if (program.state === "missing")
    return { ready: true, text: "Installs on first use" };
  const models = harness.models.length;
  return {
    ready: true,
    text: models ? `Ready · ${plural(models, "model")}` : "Ready",
  };
}
