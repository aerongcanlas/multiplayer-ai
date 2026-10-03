# Desktop harnesses and chat tabs

Each room in the desktop app has chat tabs. A tab runs one coding harness (Codex or Claude Code) in the room's repository checkout with its own model, effort, plan mode, and access setting. Tabs, their loadouts, and their transcripts are saved on this desktop and survive a restart. Every tab in a room shares the same checkout, so two tabs editing at once can collide, as in Conductor.

## Managed programs

The app downloads a pinned build of each harness the first time a tab needs it and stores it in app data under `harnesses/<harness>/<version>/`:

| Harness     | Pinned version | Source                                                                 | Verified against                                                  |
| ----------- | -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Codex       | 0.160.0        | `openai/codex` GitHub release, per-platform `codex-package-*.tar.zst`  | the release's sha256 digest, then the unpacked `bin/codex` digest |
| Claude Code | 2.1.286        | `downloads.claude.ai/claude-code-releases/<version>/<platform>/claude` | the sha256 in the paired Claude Agent SDK 0.3.286 `manifest.json` |

Codex ships as a package rather than a lone binary because `codex` needs its companions (`codex-code-mode-host`, `rg`) beside it; without them its command tool fails closed. A download is written to a `.partial` file, hashed while it streams, unpacked if needed (packages into a staging folder that refuses absolute paths, `..`, and links), checked again, and moved into place with a `.meta` record. A file without a matching `.meta` record is re-verified before use, and a mismatch is downloaded again. A checksum failure deletes the download and shows the failure with **Retry download**. The Codex digest is taken from the GitHub release when the pin is set, so it protects against tampering in transit, not a bad upstream release.

Maintainers regenerate `apps/desktop/src/supervisor/programs/manifest.ts` with `node apps/desktop/scripts/harness-manifest.mjs` when pins move, and regenerate the Codex protocol types with `codex app-server generate-ts --experimental --out apps/desktop/src/supervisor/harnesses/codex/generated` from the pinned binary, then `node apps/desktop/scripts/codex-types.mjs` to keep only the types the adapter imports. The Claude Agent SDK's own platform binary is left out of the installer; Claude Code tabs use the managed CLI.

## Custom executables

**Settings › a harness › Program › Choose executable…** points a harness at a program of your own. The path is chosen in a native file dialog. Before use, the app checks it: Codex must answer `initialize`, and Claude Code's `--version` must parse. A version other than the pin shows a warning but is allowed. A missing or failing executable shows guidance and never falls back to a download; **Use managed program** switches back.

## Sign-in

- **Codex:** sign in from the app with **Sign in with ChatGPT**. The official login page opens in your browser; only `auth.openai.com` and `chatgpt.com` URLs are opened. Codex uses your ChatGPT subscription.
- **Claude Code:** tabs reuse the Claude Code login already on this computer (`claude auth status`). If there is none, the app shows guidance to sign in once with the Claude Code CLI. It never offers claude.ai sign-in, because Anthropic's Agent SDK terms do not allow third-party products to offer it without approval, and it shows a one-time notice explaining this.

**Settings** (the gear at the bottom of the sidebar) has a page per harness with its program, account, and Codex usage limits. The refresh button re-reads sign-in state and models.

## Models and output style

Each harness's Settings page lists its models. The switch on a row shows or hides that model in a tab's model picker; a tab already on a hidden model keeps it, and the default model always shows. **Set as default** chooses the model new tabs start on.

Claude Code's page also has **Output style**, listing the styles Claude Code offers. The choice applies to tabs opened or reopened after the change; "Claude Code's own setting" leaves the style to your Claude Code configuration.

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

## Slash commands and skills

Type `/` at the start of a tab's message to list what the tab's harness offers in the room's repository. Up and Down move through the list, Enter or Tab completes the command so you can add arguments, and Escape closes the list. Sending the message runs the command.

- **Claude Code** lists its own commands and your user, project, and plugin skills.
- **Codex** lists your enabled skills. A message that starts with a skill's `/name` is sent as a mention of that skill.

The list refreshes each time it opens, at most every 30 seconds per repository. A `/name` the harness does not know is sent as typed.

## Transcripts and recovery

Transcript entries are marked for what they may share with a future read-along view: messages and plans in full, tool calls and approvals as a one-line summary (command output and diffs stay local), and reasoning and question answers not at all. Nothing is shared in this release.

If the app quits during a turn, the tab shows the turn as interrupted after restart and clears pending approvals and questions; send a follow-up to continue the same session. If a harness cannot resume a tab's session, the tab says so and offers **Start fresh session**.

## Mission Control and sub-agents

Mission Control follows the active tab. **Lead context** shows the tab's harness, model, mode, status, and the harness's own plan: Codex plan updates, or Claude Code's to-do list from `TodoWrite` or `TaskCreate`/`TaskUpdate`. A tab whose harness kept no plan says so. **Agent tasks** lists the sub-agents the tab's harness spawned, grouped by turn, newest first. Selecting a card opens that sub-agent's transcript read-only in the main area. Multiplayer AI tracks sub-agents; it does not start, message, or stop them individually.

How each harness reports sub-agents:

- **Claude Code:** `local_agent` tasks that are not ambient become cards keyed by task ID (`task_started`, `task_progress`, `task_updated`, `task_notification`). Messages tagged with the spawning tool call become that card's entries, and a sub-agent spawned inside another nests under it. Background shell commands and other tasks get no card but keep the query open and are stopped by Stop.
- **Codex:** a thread whose `thread/started` names the tab's thread, or one of its sub-agents, as its parent becomes a card keyed by thread ID. That thread's notifications and server requests route to the tab. Spawn and follow-up collab calls, sub-agent activity items, and the thread's own turns drive the card, so a follow-up to a finished sub-agent sets it running again.

Adapters report sub-agent events on a session listener, separate from the owner's turn. The same listener carries:

- **Requests outside a turn.** A sub-agent's approval or question shows in the lead transcript naming the sub-agent, marks the tab header, and never blocks the next message. A turn's end cancels only the lead's own requests; Stop, close, session reset, a harness change, a crash, or a restart also cancel sub-agent requests.
- **Harness-started turns.** When a harness wakes the lead by itself, for example after a background sub-agent finishes, the tab runs that turn like one you sent. Claude Code matches each result to its send by the user message ID, so such a turn never ends yours.
- **Crashes outside a turn.** Running cards read interrupted.

A turn can end while sub-agents keep running: the tab goes idle and its header shows the running count. Stop on that tab stops them, and their cards read stopped. A card still running when the app quits reads interrupted after restart. Closing a tab with running sub-agents asks first, and a session reset or harness change waits until they settle. Harnesses that do not report sub-agents show that in Agent tasks rather than cards built from tool calls.

Cards and sub-agent entries are transcript entries.

### Watching a host's shared tab

While read-along is on for a tab, room members who open it see that tab in Mission Control instead of their own: **Lead context** shows the host, harness, model, status, and plan, and **Agent tasks** shows the host's sub-agent cards grouped by turn, updating on the same cadence as the shared transcript. Returning to one of your own tabs switches Mission Control back. Prompt suggestions always stay your own.

What is shared, masked for credentials before it leaves the host's desktop:

- **Cards:** the task, sub-agent name and type, status, elapsed time, tool count, the latest tool as one line, and the final summary.
- **Plan state:** up to 50 plan steps of 300 characters, the running sub-agent count, and whether the harness reports sub-agents.

A sub-agent's own messages, tool calls, and reasoning are not shared, so a spectator's card is not selectable and opens no transcript. Spectators control nothing: a tab waiting on an approval reads **Needs the host**.

Sharing follows the switch. A sub-agent already running when read-along goes on appears from then, labeled **Joined mid-run**, without the tool it last used before the switch. When read-along goes off, cards stop updating and stay as ended history; a card still running then reads **Was running**. A host on an older app, or a shared database without the sub-agent migration (`20261002120000_desktop_tab_read_along_agents.sql`), shows "This host's app doesn't share sub-agents yet" instead of cards, and the shared transcript keeps working.

## Release checks

Before a release, run the live checks against disposable checkouts with a signed-in machine:

- `node apps/desktop/scripts/codex-e2e.mjs --live --repository <checkout>`: managed download, models, a plan-mode turn, a declined approval, and Stop.
- `node apps/desktop/scripts/claude-e2e.mjs --repository <checkout>`: managed download with the existing login, models, a project skill that asks a question, plan-mode continue, and resume after restart.
- Sub-agents, by hand: in a Claude Code tab, ask for a background sub-agent and check its card, drill-in, the lead's own reply after it finishes, and Stop. In a Codex tab with multi-agent enabled in your Codex config, check a card, drill-in, a follow-up to a finished sub-agent, and a sub-agent approval in ask mode.

A Claude Code tab on Windows without Git for Windows must also run a shell command; that check needs a Windows machine.

## Troubleshooting

- **Download failed:** check your connection and choose **Retry download**. A checksum failure means the file changed in transit or upstream; the app never runs it.
- **Custom executable unusable:** make sure the file exists and is executable, or switch back to the managed program.
- **Signed out mid-turn:** the tab shows a sign-out notice; sign in again (Codex in the app, Claude Code in its CLI), refresh the harness, then send a follow-up.
- **Usage limit:** the error shows when the limit resets, if the harness reports it.
- **A model disappeared:** the model picker is flagged; choose another model before sending.
