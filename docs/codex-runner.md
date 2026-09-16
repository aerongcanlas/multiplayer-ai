# ChatGPT subscription runner

The desktop can run a lead and specialist agents through a local Codex App Server signed into ChatGPT. Each host uses its own operating-system user's Codex login. Supabase room sign-in remains separate.

## Connect and run

1. Install the native Codex CLI executable, version **0.147.0**. On Windows, the desktop also detects the executable bundled with an installed Codex desktop app. This version is checked before starting App Server; the executable is not bundled into Multiplayer AI.
2. Open Multiplayer AI and choose **Connect ChatGPT**. An existing ChatGPT-authenticated Codex login is reused. Otherwise, finish the official sign-in in your browser. API-key execution is disabled for this adapter.
3. Select a local Git repository. Open **Run settings** to choose a model, reasoning effort, access mode, and a maximum of one to three concurrent specialists.
4. Submit a direction. The lead returns bounded assignments, the supervisor creates separate Codex sessions, specialists return results, and an independent validator reviews the combined results. The lead publishes a final summary.
5. Use **Stop** to interrupt active turns. Command or file-change requests that need permission appear with **Approve once** and **Decline** controls.

The account panel shows available usage information. All agent sessions use the host's ChatGPT allowance. Disconnecting signs out of the local Codex login used by other Codex clients too; stop this app's active work first. The application does not read, copy, upload, or store OAuth tokens itself.

## Access and evidence

**Read-only** is the initial access mode. Agents inspect the selected checkout, including current local changes, under the Codex read-only sandbox. Instructions forbid edits, builds, dependency installs, credential access, and external service calls. Live validation uses this mode against an explicitly selected repository.

**Edit isolated worktrees** requires a clean checkout. The app creates an integration branch and separate worktrees for writing specialists. Integration is serialized. Conflicts and worktrees are retained for review; the user's original checkout is not reset or switched. Agents are instructed not to commit, push, deploy, or publish. Review the retained branch and patch before applying it to your own branch.

Command exit results and independent review reports are recorded as different evidence types. A review reporting completion does not imply that a build or test suite ran. The final summary must preserve missing checks and failed criteria. Read-only validators do not run builds by default.

Provider thread identifiers are retained only in the local SQLite journal. Restart recovers interrupted executions as blocked and clears stale approval requests. It does not replay commands. Completed history and summaries remain available.

## Shared rooms

Chat and prompt suggestions continue to synchronize through the existing Supabase integration. Agent executions, private command output, approvals, patches, and lead summaries currently remain on the host desktop. This runner integration does not change the Supabase schema. Shared execution leases and published progress require a separate reviewed migration and transport implementation.

## Validation

- `pnpm check`: type checks, lint, supervisor/protocol/worktree tests, embedded PostgreSQL authorization checks, and desktop build.
- `pnpm --filter @multiplayer-ai/desktop test:codex`: Electron UI checks against a local JSONL Codex fixture. No live model or service requests.
- `node apps/desktop/scripts/codex-e2e.mjs --live --repository "C:\path\to\repo"`: explicit live ChatGPT test. Replace the example path with a repository you authorize for inspection. Uses the signed-in user's allowance, inspects the supplied repository read-only, and verifies its Git status/revision and tracked/untracked file hashes before and after. It never automatically accepts an approval request.

Reports and screenshots are written beneath `output/playwright/codex-*`. Existing `test:shared` uses a local Supabase fixture; no Supabase/Vercel APIs are used for validation.

### Historical standalone live result

On 2026-09-05, the Electron app connected through ChatGPT sign-in and ran a lead, planner, and independent validator against a local test repository. All three completed. The run recorded 23 command results and an independent review, published a lead summary, and retained completed history after restarting Electron. No builds or repository edits were requested.

Git revision/status and hashes of all 98 tracked/untracked non-ignored files matched before and after. The test recorded no renderer errors. Reports and execution records are retained locally under the ignored `output/` directory. The worktree write path is covered by isolated local Git fixtures; it was not exercised in this live test.

Final regression checks passed: all workspace type checks and lint; 19 supervisor/security/OAuth tests plus one embedded PostgreSQL test; 7 Codex UI checkpoints; 11 packaged desktop checkpoints; and 8 shared-room checkpoints. The rebuilt Windows executable is `apps/desktop/release/win-unpacked/Multiplayer AI.exe`.

## Protocol boundary

App Server runs over private stdio behind the existing utility-process supervisor. The renderer can issue only validated app commands, and cannot supply arbitrary JSON-RPC, filesystem paths, or process calls. Private command evidence may contain paths on the host. Credentials never enter renderer snapshots. Native Codex subagent tools are disabled because the application owns the task graph and concurrency limits. The integration uses stable thread/turn calls and structured lead outputs rather than experimental dynamic tools.

Official references: [App Server](https://learn.chatgpt.com/docs/app-server), [authentication](https://learn.chatgpt.com/docs/auth), and [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
