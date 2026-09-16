import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrivateWorkspace } from "../shared/contracts";

const exec = promisify(execFile);

export async function inspectWorkspace(
  selectedPath: string,
  id: string = randomUUID(),
): Promise<PrivateWorkspace> {
  const path = await realpath(selectedPath);
  const git = async (...args: string[]) =>
    (
      await exec(
        "git",
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-C",
          path,
          ...args,
        ],
        { windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024 },
      )
    ).stdout.trim();
  try {
    if ((await git("rev-parse", "--is-inside-work-tree")) !== "true")
      throw new Error();
    const [root, revision, branch, status] = await Promise.all([
      git("rev-parse", "--show-toplevel"),
      git("rev-parse", "--verify", "HEAD"),
      git("rev-parse", "--abbrev-ref", "HEAD"),
      git("status", "--porcelain", "--untracked-files=no"),
    ]);
    return {
      id,
      name: basename(root),
      path: await realpath(root),
      revision,
      branch,
      dirty: status.length > 0,
    };
  } catch {
    throw new Error(
      "Choose a Git repository with at least one commit. Git must be installed and available.",
    );
  }
}

export function publicWorkspace({
  id,
  name,
  branch,
  revision,
  dirty,
}: PrivateWorkspace) {
  return { id, name, branch, revision, dirty };
}
