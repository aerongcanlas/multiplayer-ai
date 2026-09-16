import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);

export async function repositoryCommand(
  cwd: string,
  ...args: string[]
): Promise<string> {
  const result = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      cwd,
      ...args,
    ],
    { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

/** Retains every worktree for review. Never resets or cleans a user's checkout. */
export class Worktrees {
  private assignedRevisions = new Map<string, string>();
  readonly branch: string;
  readonly integration: string;
  constructor(
    private repository: string,
    private directory: string,
    private executionId: string,
    private baseline: string,
  ) {
    this.branch = `multiplayer/run-${executionId}`;
    this.integration = join(directory, executionId, "integration");
  }
  async prepare() {
    if (await repositoryCommand(this.repository, "status", "--porcelain"))
      throw new Error(
        "Commit or stash repository changes before choosing worktree mode. Read-only runs can inspect the current checkout.",
      );
    await mkdir(join(this.directory, this.executionId), { recursive: true });
    await repositoryCommand(
      this.repository,
      "worktree",
      "add",
      "-b",
      this.branch,
      this.integration,
      this.baseline,
    );
  }
  async assign(taskId: string): Promise<string> {
    const path = join(this.directory, this.executionId, taskId);
    const revision = await repositoryCommand(
      this.integration,
      "rev-parse",
      "HEAD",
    );
    await repositoryCommand(
      this.repository,
      "worktree",
      "add",
      "--detach",
      path,
      revision,
    );
    this.assignedRevisions.set(path, revision);
    return path;
  }
  async integrate(path: string) {
    if (
      (await repositoryCommand(path, "rev-parse", "HEAD")) !==
      this.assignedRevisions.get(path)
    )
      throw new Error(
        "A specialist changed Git history. Its worktree was retained for review and was not integrated automatically.",
      );
    await repositoryCommand(path, "add", "--all");
    const staged = await repositoryCommand(
      path,
      "diff",
      "--cached",
      "--name-only",
    );
    if (!staged) return;
    await repositoryCommand(
      path,
      "-c",
      "user.name=Multiplayer AI",
      "-c",
      "user.email=local@multiplayer.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Apply assigned desktop agent changes",
    );
    const revision = await repositoryCommand(path, "rev-parse", "HEAD");
    try {
      await repositoryCommand(
        this.integration,
        "-c",
        "user.name=Multiplayer AI",
        "-c",
        "user.email=local@multiplayer.invalid",
        "-c",
        "commit.gpgsign=false",
        "cherry-pick",
        revision,
      );
    } catch {
      throw new Error(
        `Integration conflict retained on ${this.branch}. Review the worktree before continuing.`,
      );
    }
  }
  async artifact() {
    return {
      branch: this.branch,
      revision: await repositoryCommand(this.integration, "rev-parse", "HEAD"),
      files: (
        await repositoryCommand(
          this.integration,
          "diff",
          "--name-only",
          this.baseline,
        )
      )
        .split("\n")
        .filter(Boolean),
      diff: (
        await repositoryCommand(
          this.integration,
          "diff",
          "--no-ext-diff",
          this.baseline,
        )
      ).slice(0, 100_000),
    };
  }
}
