# Desktop harnesses and chat tabs

Each room in the desktop app has chat tabs. A tab runs one coding harness (Codex, Claude Code, or OpenCode) in the room's repository checkout with its own model, effort, plan mode, and access setting. Tabs, their loadouts, and their transcripts are saved on this desktop and survive a restart. Every tab in a room shares the same checkout, so two tabs editing at once can collide, as in Conductor.

## Managed programs

The app downloads a pinned build of each harness the first time a tab needs it and stores it in app data under `harnesses/<harness>/<version>/`:

| Harness     | Pinned version | Source                                                                                        | Verified against                                                      |
| ----------- | -------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Codex       | 0.160.0        | `openai/codex` GitHub release, per-platform `codex-package-*.tar.zst`                         | the release's sha256 digest, then the unpacked `bin/codex` digest     |
| Claude Code | 2.1.286        | `downloads.claude.ai/claude-code-releases/<version>/<platform>/claude`                        | the sha256 in the paired Claude Agent SDK 0.3.286 `manifest.json`     |
| OpenCode    | 1.18.34        | npm per-platform packages (`opencode-darwin-arm64`, `opencode-windows-x64`, …), gzip tarballs | the tarball's sha256, then the unpacked `package/bin/opencode` digest |

Codex ships as a package rather than a lone binary because `codex` needs its companions (`codex-code-mode-host`, `rg`) beside it; without them its command tool fails closed. A download is written to a `.partial` file, hashed while it streams, unpacked if needed (packages into a staging folder that refuses absolute paths, `..`, and links), checked again, and moved into place with a `.meta` record. A file without a matching `.meta` record is re-verified before use, and a mismatch is downloaded again. A checksum failure deletes the download and shows the failure with **Retry download**. The Codex digest is taken from the GitHub release when the pin is set, so it protects against tampering in transit, not a bad upstream release.

OpenCode's digests are computed when the pin is set, after checking each tarball against npm's sha512 `dist.integrity` (trust on first use, as with Codex). In-app OpenCode updates stay within the pinned 1.18 line, because the permission lockdown below was verified only there: a newer patch is offered as an update and checked against npm's sha512 integrity, and a newer minor shows as "available after an app update". The update URL is built from the fixed registry host and package name, never taken from the registry's response.

Maintainers regenerate `apps/desktop/src/supervisor/programs/manifest.ts` with `node apps/desktop/scripts/harness-manifest.mjs` when pins move (`--only=opencode` re-pins one harness and keeps the others' entries), and regenerate the Codex protocol types with `codex app-server generate-ts --experimental --out apps/desktop/src/supervisor/harnesses/codex/generated` from the pinned binary, then `node apps/desktop/scripts/codex-types.mjs` to keep only the types the adapter imports. The Claude Agent SDK's own platform binary is left out of the installer; Claude Code tabs use the managed CLI.

## Custom executables

**Settings › a harness › Program › Choose executable…** points a harness at a program of your own. The path is chosen in a native file dialog. Before use, the app checks it: Codex must answer `initialize`, Claude Code's `--version` must parse, and OpenCode must answer ACP `initialize` from `opencode acp`. A version other than the pin shows a warning but is allowed. A missing or failing executable shows guidance and never falls back to a download; **Use managed program** switches back.

## Sign-in

Claude Code and Codex tabs sign in to app-owned home folders, separate from the same programs in your terminal. Logging in, refreshing, or logging out of Claude Code or Codex in a terminal never signs a tab out, and the app never changes or removes your terminal's login. After upgrading, each starts signed out once, with a one-time notice; no terminal login is imported, because copying a rotating refresh token would bring back the race this avoids.

| Harness     | App home (`<data>/accounts/<harness>`) | Home variable       | Where the login lives                                                                                                       |
| ----------- | -------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `accounts/claude`                      | `CLAUDE_CONFIG_DIR` | Claude Code's own keychain item for that folder (`Claude Code-credentials-<hash>`) on macOS, its credentials file elsewhere |
| Codex       | `accounts/codex`                       | `CODEX_HOME`        | Codex's `auth.json` or keyring entry for that home                                                                          |

- **Claude Code:** **Sign in** runs the unmodified Claude Code's own `claude auth login --claudeai` against the app's folder. Claude Code opens Anthropic's page in your browser and stores the result itself; the app never sees your password or token. **Sign out** runs Claude Code's `claude auth logout` against the same folder.
- **Codex:** **Sign in with ChatGPT** opens the official login page in your browser; only `auth.openai.com` and `chatgpt.com` URLs are opened. **Sign out** sends Codex's `account/logout` and closes its app-server.
- **OpenCode:** there is no in-app sign-in, and OpenCode keeps using its own data folder, as in your terminal (see "Tool shells" below for why). OpenCode is ready once at least one model is usable: a model on a local server (see below), or a provider OpenCode itself is logged in to or configured with. Settings shows a copy-ready `auth login` command for the program the app runs, quoted for zsh and bash, or for PowerShell, with **Copy** and **Refresh**. There is no Sign out, since it would remove your terminal's OpenCode login. With no usable model, Settings and the tab show **No models available** with setup guidance.

A sign-in can be cancelled from Settings (**Cancel sign-in**) and ends by itself after 10 minutes. Only one runs per harness at a time, a failed sign-in shows why (the program's last error line, with links and token-like text removed), and quitting the app ends any pending sign-in program. **Sign out** asks first when that harness has running tabs; it stops their turns, closes every live session of that harness, and leaves a notice that names only the harness, never the account, because read-along publishes notices.

Existing Claude Code tabs keep their sessions: before a resume, a session found only in your terminal's Claude Code folder is copied once into the app's folder. Codex and OpenCode tabs that cannot resume offer **Start fresh**. From then on, new Claude Code and Codex history lives in the app's folders, so `claude --resume` in a terminal does not list tab sessions.

The app's folders are created with mode 0700 on macOS and Linux. If the accounts folder cannot be created, the harness shows as unavailable with the reason, and no harness program, sign-in, or sign-out runs; the app never falls back to your terminal's folders. Development builds share one accounts folder (`<appData>/Multiplayer AI Dev/accounts`) across checkouts, so each worktree does not need its own sign-in; packaged builds, explicit `--user-data-dir` profiles, and E2E runs keep it inside their own profile.

**Why Claude Code sign-in is allowed.** Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) bars developers from offering claude.ai login in their own applications and from collecting, storing, or intermediating claude.ai credentials or tokens; sign-in must complete through Anthropic's own flow. It carves out end users signing in to the unmodified Claude Code program with their own subscription, including where a platform hosts Claude Code. The app runs the unmodified program's own login, Anthropic's page completes it, Claude Code stores the result, and the app never handles the token, whether the program is the managed download or your own executable.

**Uninstalling.** Removing the app leaves Claude Code's keychain item for the app's folder (and a Codex keyring entry, if Codex uses the keyring). Sign out of each harness in Settings before uninstalling, or delete the `Claude Code-credentials-<hash>` item in Keychain Access afterwards.

**Settings** (the gear at the bottom of the sidebar) has a page per harness with its program, account and plan, the sign-in controls above, and Codex usage limits. The refresh button re-reads sign-in state and models.

## Models and output style

Each harness's Settings page lists its models. The switch on a row shows or hides that model in a tab's model picker; a tab already on a hidden model keeps it, and the default model always shows. **Set as default** chooses the model new tabs start on.

Claude Code's page also has **Output style**, listing the styles Claude Code offers. The choice applies to tabs opened or reopened after the change; "Claude Code's own setting" leaves the style to your Claude Code configuration.

## Local models (OpenCode)

On each refresh, OpenCode's page probes Ollama (`127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234`) with a short timeout and shows a line per server, such as "Ollama · 3 models" or "LM Studio · not running". Only models that report tool support are offered: Ollama's `tools` capability, or LM Studio's `tool_use` (an LM Studio model that reports no capabilities is kept and marked unverified). Embedding models never appear. The app adds those servers to OpenCode as `ollama` and `lmstudio` providers in memory, unless your OpenCode config (global or the project's) already defines a provider with that name; then your own entry wins and nothing is added. No config file is written.

The context limit given to OpenCode is the one the server actually serves, not the model's trained maximum: Ollama's `num_ctx` parameter when the model sets one, else the context of the loaded model; LM Studio's loaded context length. When it is under 32k or unknown, Settings shows a warning, because agentic use with tools needs more. For Ollama, start the server with a larger `OLLAMA_CONTEXT_LENGTH` ([Ollama context length](https://docs.ollama.com/context-length)); `ollama launch opencode` also sets Ollama up for OpenCode. In LM Studio, load the model with a larger context.

Only `127.0.0.1` is checked. An `OLLAMA_HOST` pointing at another machine is noted in Settings; model servers on other machines are not supported yet.

OpenCode never silently falls back to its own cloud. Unless you logged in to OpenCode's hosted provider, the app disables it for app-launched sessions, so OpenCode's anonymous free hosted models are hidden and never count as a usable model. The model new tabs start on is your OpenCode config's `model`, else the default you chose in Settings, else the first local model. Titles and summaries use a local model whenever one exists. Every turn sets the tab's model explicitly.

## Access modes and plan mode

The tab's access setting replaces the harness's own sandbox and approval settings for tab turns.

| Access             | Codex                                                                     | Claude Code                                                       |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Ask before acting  | read-only sandbox, approvals on request, routed to the tab                | `default` permission mode; tool requests appear as approval cards |
| Act without asking | workspace-write sandbox on the checkout with network access, no approvals | `acceptEdits` permission mode; other tools are allowed            |

OpenCode tabs keep the access setting by injecting permission rules into every OpenCode process (`OPENCODE_CONFIG_CONTENT`, then `OPENCODE_PERMISSION`), at the top level and in every agent, because agent rules take precedence over global ones:

| OpenCode tool class                                                              | Ask before acting | Act without asking                        |
| -------------------------------------------------------------------------------- | ----------------- | ----------------------------------------- |
| Edits, shell, web fetch and search, code search, skills, your MCP servers' tools | approval card     | runs without a card                       |
| Access outside the checkout (`external_directory`)                               | approval card     | refused; the turn continues with a notice |
| Read-only tools inside the checkout (read, grep, glob, list, LSP)                | run               | run                                       |
| Sub-agents (`task`)                                                              | denied            | denied                                    |

A `deny` rule in your OpenCode config always wins, in either mode: it is kept after the injected rules at every level. Rules `opencode debug config` masks (under secret-looking names) are treated as denies. `task` is denied because OpenCode 1.18 drops sub-agent permission requests under ACP, which would hang a turn. A permission request that no open tab owns is rejected, never allowed. "Act without asking" has no OS sandbox for OpenCode: shell commands run with your permissions, so the checkout boundary covers file access, not what a command can reach.

Plan mode uses each harness's native plan mode (Codex's `plan` collaboration mode, Claude Code's `plan` permission mode, OpenCode's `plan` agent; a turn without plan mode runs OpenCode's `build` agent). OpenCode's plan arrives as assistant text, so it makes no plan card. **Continue into execution** switches the tab to its access mode and continues. Questions a harness asks, such as a skill's multiple choice or a plan-mode clarification, appear as question cards. **Stop** declines or cancels anything pending, then interrupts the turn.

## Your harness setup carries over

Tabs load the host's own setup as the harness's terminal would: skills, plugins, slash commands, instruction files (`AGENTS.md`, `CLAUDE.md`), hooks, and configured MCP servers. Codex runs `app-server` without overrides; Claude Code runs with the `claude_code` system prompt and user, project, and local settings.

Because Claude Code and Codex tabs run in the app's folders, the app links your setup into them at every launch, so later changes reach the next new session without reinstalling:

- **Claude Code** (from `$CLAUDE_CONFIG_DIR`, else `~/.claude`): `CLAUDE.md`, `skills`, `agents`, `commands`, `output-styles`, and `plugins` are linked, and each `projects/<name>/memory` folder is linked one level deep, so project auto-memory is shared. `settings.json` is copied instead, because Claude Code refuses to write settings through a link: a change a tab makes (such as a model choice) stays in the app's copy, which is set aside as `settings.json.app-<date>.bak` and refreshed when your own file changes. User and local MCP servers are read from your `.claude.json` (in `$CLAUDE_CONFIG_DIR` when set, else `~/.claude.json`) and handed to Claude Code over the SDK's control channel, never on a command line; only server names appear in app state or logs.
- **Codex** (from `$CODEX_HOME`, else `~/.codex`): `config.toml`, `AGENTS.md`, `skills`, `prompts`, `rules`, and `plugins` are linked. Writes Codex makes (project trust, a default model) go through the link to your own file, as they do from a terminal.
- **OpenCode** uses your config folder and data folder directly, as before.

On Windows, folders are linked as junctions and files are copied. A manifest in each app folder records what the app made; a link the harness replaced with a real file is set aside as `<name>.app-<date>.bak` and linked again, a link whose source you removed is removed, and files the harness created itself are never touched. Credentials, account files, and transcripts (`.credentials.json`, `.claude.json`, `auth.json`, `sessions`, and the rest of `projects/`) are never linked. Remote MCP servers that use OAuth need to be authorized again inside the tab (for example `/mcp` in a Claude Code tab), because their tokens live in each harness's own credential store.

**Credentials in linked config.** Settings in your own Claude Code `settings.json` that bring their own credential (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, or `env` entries for Anthropic, Bedrock, Vertex, Foundry, or OAuth variables) still apply in tabs and override the app's sign-in. Settings shows a warning naming the setting, never its value. OpenCode loads its config files (global, the project's `opencode.json`, and `.opencode` folders), agents, commands, instructions, and MCP servers. A project's own OpenCode config counts as yours, as Claude Code's project settings do, so a cloned repository's config can add MCP servers or providers to that repository's tabs.

App-launched OpenCode sessions differ from OpenCode in your terminal in three ways: tool permissions are gated as above, `task` is denied, and OpenCode's hosted provider is disabled without its login. The injected config lives only in the child process environment; the app writes nothing to your OpenCode config. OpenCode itself still does its usual housekeeping in its config folder when it runs (a `.gitignore`, its plugin package, a `$schema` line), as it does from a terminal. Each OpenCode process listens on `127.0.0.1` only, with a random server password per process, and auto-update is off. One process serves all tabs that need the same config; a tab whose config changed (for example after a refresh found a new local model) moves to a new process at its next turn, resuming its session, while turns still running on the old process finish there.

Harnesses launch with your login-shell environment, so `PATH`, `SSH_AUTH_SOCK`, and proxies match your terminal, except that `CLAUDE_CONFIG_DIR` and `CODEX_HOME` name the app's folders. Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CURSOR_API_KEY`, and `OPENCODE_API_KEY`, and Claude Code's `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`, and `CLAUDE_SECURESTORAGE_CONFIG_DIR`, are removed so harnesses use their own sign-in. Claude Code also runs with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and `DISABLE_AUTOUPDATER=1`. On Windows, Claude Code uses its PowerShell tool when Git for Windows is absent.

**Tool shells.** Commands a Claude Code or Codex tab runs inherit `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so `claude` or `codex` started inside a tab uses the app's login, and an agent's shell can read the app's credential file where the harness keeps one in plaintext (Linux and Windows), just as it can read your terminal's today. OpenCode is not isolated for the same reason: its tool shells would see an app `XDG_DATA_HOME`, which moves data for pnpm and other XDG-aware tools, and the only in-process fix (an OpenCode plugin) makes OpenCode install a package into your OpenCode config folder.

## Slash commands and skills

Type `/` at the start of a tab's message to list what the tab's harness offers in the room's repository. Up and Down move through the list, Enter or Tab completes the command so you can add arguments, and Escape closes the list. Sending the message runs the command.

- **Claude Code** lists its own commands and your user, project, and plugin skills.
- **Codex** lists your enabled skills. A message that starts with a skill's `/name` is sent as a mention of that skill.
- **OpenCode** lists the commands and skills it announced for a session in that repository, so the list is empty until an OpenCode tab has opened a session there.

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

A turn can end while sub-agents keep running: the tab goes idle and its header shows the running count. Stop on that tab stops them, and their cards read stopped. A card still running when the app quits reads interrupted after restart. Closing a tab with running sub-agents asks first, and a session reset or harness change waits until they settle. Harnesses that do not report sub-agents show that in Agent tasks rather than cards built from tool calls. OpenCode is one: its ACP connection reports no sub-agents, and app-launched sessions deny its `task` tool.

Cards and sub-agent entries are transcript entries.

### Watching a host's shared tab

While read-along is on for a tab, room members who open it see that tab in Mission Control instead of their own: **Lead context** shows the host, harness, model, status, and plan, and **Agent tasks** shows the host's sub-agent cards grouped by turn, updating on the same cadence as the shared transcript. Returning to one of your own tabs switches Mission Control back. Prompt suggestions always stay your own.

What is shared, masked for credentials before it leaves the host's desktop:

- **Cards:** the task, sub-agent name and type, status, elapsed time, tool count, the latest tool as one line, and the final summary.
- **Plan state:** up to 50 plan steps of 300 characters, the running sub-agent count, and whether the harness reports sub-agents.

A sub-agent's own messages, tool calls, and reasoning are not shared, so a spectator's card is not selectable and opens no transcript. Spectators control nothing: a tab waiting on an approval reads **Needs the host**.

Sharing follows the switch. A sub-agent already running when read-along goes on appears from then, labeled **Joined mid-run**, without the tool it last used before the switch. When read-along goes off, cards stop updating and stay as ended history; a card still running then reads **Was running**. A host on an older app, or a shared database without the sub-agent migration (`20261002120000_desktop_tab_read_along_agents.sql`), shows "This host's app doesn't share sub-agents yet" instead of cards, and the shared transcript keeps working. OpenCode tabs share under the same rules once the shared database has `20261004120000_desktop_tab_read_along_opencode.sql`.

## Release checks

Before a release, run the live checks against disposable checkouts with a signed-in machine:

- `node apps/desktop/scripts/codex-e2e.mjs --live --repository <checkout>`: managed download, a real ChatGPT sign-in into the app's `CODEX_HOME` (the script prints the page to open), models, a plan-mode turn, a declined approval, Stop, and Sign out.
- `node apps/desktop/scripts/claude-e2e.mjs --repository <checkout>`: managed download, a real sign-in through Anthropic's page into the app's folder, a logout in a throwaway stand-in for your Claude Code folder that leaves the tab signed in (your real `~/.claude` is never touched), a carried-over skill, models, a project skill that asks a question, plan-mode continue, two tabs at once, resume after restart, and Sign out leaving no stored login. Afterwards, check Keychain Access has no `Claude Code-credentials-` item for the run's folder.
- `pnpm --filter @multiplayer-ai/desktop test:opencode` (needs Ollama on `127.0.0.1:11434` with a tool-capable model; `--model <name>` picks one): managed download, "No models available" with no local server and no OpenCode login, a real model's file edit after one approval, the loopback server refusing a request without its password, Stop, and resume after restart. OpenCode's config and data stay in the run's output folder unless `--host-config` is passed. Record the result in the release PR.
- Sub-agents, by hand: in a Claude Code tab, ask for a background sub-agent and check its card, drill-in, the lead's own reply after it finishes, and Stop. In a Codex tab with multi-agent enabled in your Codex config, check a card, drill-in, a follow-up to a finished sub-agent, and a sub-agent approval in ask mode.

A Claude Code tab on Windows without Git for Windows must also run a shell command; that check needs a Windows machine.

## Troubleshooting

- **Download failed:** check your connection and choose **Retry download**. A checksum failure means the file changed in transit or upstream; the app never runs it.
- **Custom executable unusable:** make sure the file exists and is executable, or switch back to the managed program.
- **Signed out mid-turn:** the tab shows a sign-out notice; sign in again from the tab or Settings, then send a follow-up.
- **A sign-in never finishes:** choose **Cancel sign-in** and try again; it also ends by itself after 10 minutes. For Claude Code, finish the page Claude Code opened in your browser.
- **Usage limit:** the error shows when the limit resets, if the harness reports it.
- **A model disappeared:** the model picker is flagged; choose another model before sending.
- **OpenCode shows No models available:** start Ollama or LM Studio with a tool-capable model and refresh OpenCode in Settings, run `ollama launch opencode`, or sign in a provider with the command in Settings.
- **OpenCode answers poorly or loses track:** check the context warning in Settings; a local model served with a small context truncates OpenCode's tool instructions.
- **OpenCode does not offer a model right now:** OpenCode's model catalog can lag a new session; the app retries once, then names the model. Refresh OpenCode in Settings or choose another model.
- **OpenCode needs a login:** a provider rejected the request; run the sign-in command from Settings in a terminal, refresh, and send a follow-up.
