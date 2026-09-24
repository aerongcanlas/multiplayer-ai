# Desktop harnesses and chat tabs

Each room in the desktop app has chat tabs. A tab runs one coding harness (Codex or Claude Code) in the room's repository checkout with its own model, effort, plan mode, and access setting. Tabs, their loadouts, and their transcripts are saved on this desktop and survive a restart. Every tab in a room shares the same checkout, so two tabs editing at once can collide, as in Conductor.

## Managed programs

The app downloads a pinned build of each harness the first time a tab needs it and stores it in app data under `harnesses/<harness>/<version>/`:

| Harness     | Pinned version | Source                                                                 | Verified against                                                  |
| ----------- | -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Codex       | 0.155.1        | `openai/codex` GitHub release, per-platform `codex-package-*.tar.zst`  | the release's sha256 digest, then the unpacked `bin/codex` digest |
| Claude Code | 2.1.280        | `downloads.claude.ai/claude-code-releases/<version>/<platform>/claude` | the sha256 in the paired Claude Agent SDK 0.3.280 `manifest.json` |

Codex ships as a package rather than a lone binary because `codex` needs its companions (`codex-code-mode-host`, `rg`) beside it; without them its command tool fails closed. A download is written to a `.partial` file, hashed while it streams, unpacked if needed (packages into a staging folder that refuses absolute paths, `..`, and links), checked again, and moved into place with a `.meta` record. A file without a matching `.meta` record is re-verified before use, and a mismatch is downloaded again. A checksum failure deletes the download and shows the failure with **Retry download**. The Codex digest is taken from the GitHub release when the pin is set, so it protects against tampering in transit, not a bad upstream release.

Maintainers regenerate `apps/desktop/src/supervisor/programs/manifest.ts` with `node apps/desktop/scripts/harness-manifest.mjs` when pins move, and regenerate the Codex protocol types with `codex app-server generate-ts --experimental --out apps/desktop/src/supervisor/harnesses/codex/generated` from the pinned binary. The Claude Agent SDK's own platform binary is left out of the installer; Claude Code tabs use the managed CLI.

## Custom executables

**Harness settings › Program › Choose executable…** points a harness at a program of your own. The path is chosen in a native file dialog. Before use, the app checks it: Codex must answer `initialize`, and Claude Code's `--version` must parse. A version other than the pin shows a warning but is allowed. A missing or failing executable shows guidance and never falls back to a download; **Use managed program** switches back.

## Sign-in

- **Codex:** sign in from the app with **Sign in with ChatGPT**. The official login page opens in your browser; only `auth.openai.com` and `chatgpt.com` URLs are opened. Codex uses your ChatGPT subscription.
- **Claude Code:** tabs reuse the Claude Code login already on this computer (`claude auth status`). If there is none, the app shows guidance to sign in once with the Claude Code CLI. It never offers claude.ai sign-in, because Anthropic's Agent SDK terms do not allow third-party products to offer it without approval, and it shows a one-time notice explaining this.

Harness settings show each harness's program, account, model count, and Codex usage limits. The refresh button re-reads sign-in state and models.

## Access modes and plan mode

The tab's access setting replaces the harness's own sandbox and approval settings for tab turns.

| Access             | Codex                                                                     | Claude Code                                                       |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Ask before acting  | read-only sandbox, approvals on request, routed to the tab                | `default` permission mode; tool requests appear as approval cards |
| Act without asking | workspace-write sandbox on the checkout with network access, no approvals | `acceptEdits` permission mode; other tools are allowed            |

Plan mode uses each harness's native plan mode (Codex's `plan` collaboration mode, Claude Code's `plan` permission mode). **Continue into execution** switches the tab to its access mode and continues. Questions a harness asks, such as a skill's multiple choice or a plan-mode clarification, appear as question cards. **Stop** declines or cancels anything pending, then interrupts the turn.

## Your harness setup carries over

Tabs load the host's own setup as the harness's terminal would: skills, plugins, slash commands, instruction files (`AGENTS.md`, `CLAUDE.md`), hooks, and configured MCP servers. Codex runs `app-server` without overrides; Claude Code runs with the `claude_code` system prompt and user, project, and local settings.

Harnesses launch with your login-shell environment, so `PATH`, `SSH_AUTH_SOCK`, proxies, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` match your terminal. Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CURSOR_API_KEY` are removed so harnesses bill your subscription sign-in. Claude Code also runs with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and `DISABLE_AUTOUPDATER=1`. On Windows, Claude Code uses its PowerShell tool when Git for Windows is absent.

## Transcripts and recovery

Transcript entries are marked for what they may share with a future read-along view: messages and plans in full, tool calls and approvals as a one-line summary (command output and diffs stay local), and reasoning and question answers not at all. Nothing is shared in this release.

If the app quits during a turn, the tab shows the turn as interrupted after restart and clears pending approvals and questions; send a follow-up to continue the same session. If a harness cannot resume a tab's session, the tab says so and offers **Start fresh session**.

## Release checks

Before a release, run the live checks against disposable checkouts with a signed-in machine:

- `node apps/desktop/scripts/codex-e2e.mjs --live --repository <checkout>`: managed download, models, a plan-mode turn, a declined approval, and Stop.
- `node apps/desktop/scripts/claude-e2e.mjs --repository <checkout>`: managed download with the existing login, models, a project skill that asks a question, plan-mode continue, and resume after restart.

A Claude Code tab on Windows without Git for Windows must also run a shell command; that check needs a Windows machine.

## Troubleshooting

- **Download failed:** check your connection and choose **Retry download**. A checksum failure means the file changed in transit or upstream; the app never runs it.
- **Custom executable unusable:** make sure the file exists and is executable, or switch back to the managed program.
- **Signed out mid-turn:** the tab shows a sign-out notice; sign in again (Codex in the app, Claude Code in its CLI), refresh the harness, then send a follow-up.
- **Usage limit:** the error shows when the limit resets, if the harness reports it.
- **A model disappeared:** the model picker is flagged; choose another model before sending.
