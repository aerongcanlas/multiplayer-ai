# Electron migration notes

The standalone Electron port was integrated into `apps/desktop` in the existing pnpm/Turborepo workspace. The current web app, worker and shared runtime packages remain authoritative.

## Scope and reuse

The desktop foundation uses a packaged React renderer. The room header retains symmetric centering; the top AI activity and Group Chat panels and lower Mission Control panel remain independently resizable. Both apps now import `@multiplayer-ai/ui`: primitives, room layout, selectable chat messages, composer, agent welcome, scroll hook, utility styles and color tokens share one implementation. Existing primitive paths are re-export facades. Feature wrappers still own browser sessions, server actions, Realtime channels, AI SDK transport or Electron IPC. See [shared UI ownership](../packages/ui/README.md).

Desktop builds run independently and bundle the shared UI source into the renderer. The desktop test harness imports the shared database fixture from `@multiplayer-ai/db/testing`; production desktop transports remain app-local. Generated database types come from the canonical migrations through `pnpm db:types`.

## Runtime ownership

1. **Renderer:** presentation, local draft text, selected message IDs, layout, and the latest reconciled snapshot.
2. **Preload:** a closed list of bridge methods; subscribers receive only data and never an Electron event object.
3. **Main:** trusted document and main-frame checks, strict Zod input validation, directory chooser, read-only Git inspection, and supervisor lifecycle.
4. **Supervisor:** one active execution per desktop, Codex or mock sessions, bounded task dependencies, cancellation, journal commits, summaries, and restart recovery.
5. **Journal:** transactional state plus ordered events and local-only outbox records. A failed write does not publish uncommitted state.

The renderer subscribes before requesting initial state. Snapshot revisions prevent a late response from overwriting newer progress. Each execution event contains stable event, execution, task, and agent IDs, an execution sequence, and an ownership generation. Duplicate event inserts are idempotent. The initial generation is local-only; this is not an implemented remote lease protocol.

## Suggestions and context

Suggestion requests contain a room ID and message IDs. The supervisor loads canonical room messages and rejects cross-room IDs, unknown messages, duplicate IDs, unexpected fields, and excessive payloads. The mock suggestion builder preserves selected text and attribution; it does not claim to perform model reasoning or infer agreement.

Suggestions, their source snapshots, edits, and context version are persisted. Editing requires the expected revision. Submitting a suggestion records the exact source snapshot in the execution. A suggestion whose edit or context version is stale is rejected. Chat input reaches the agent only through deliberate selection or an explicitly submitted direction.

## Execution and recovery

The `RunnerAdapter` interface emits normalized task updates. The mock adapter exercises lead, planner, implementer, and validator roles sequentially. Mock completion requires completed tasks plus a passing simulated validation record. Failed validation remains visible. No worktree or subprocess command is run by the mock adapter; repository selection and preflight run only read-only Git inspection.

Stopping an execution aborts its runner and preserves all recorded events. A supervisor crash turns freshness stale and disables dispatch. On restart, recorded running work is marked blocked. The app never blindly replays unfinished actions. A production runner must reconcile actual child processes, worktrees, and repository revisions before offering resume.

## What remains outside the foundation

Shared-room integration adds desktop GitHub OAuth, encrypted Supabase session storage, authenticated database functions, shared chat, invitations, and shared suggestion persistence. See [shared-rooms.md](shared-rooms.md) for setup and validation. The [Codex runner](codex-runner.md) now provides local subscription authentication, lead and specialist sessions, command evidence, approval prompts, and isolated worktree integration. Shared execution events, host leases, and ownership transfer remain separate work. Joining a room grants no command execution rights on another host.

The desktop never imports the old privileged Supabase client. The renderer's network policy permits only packaged assets or the explicit loopback development origin. Main owns the authenticated Supabase transport. Only public project settings are bundled; server keys and `.vercel` metadata are excluded. The app archive contains only `out`, runtime dependencies, and its package manifest.

## Local validation

- Workspace checks cover TypeScript and ESLint for desktop, web and the shared packages.
- Desktop unit tests cover schema/sender checks, canonical message loading, persisted edits, stale context, task completion, simulated failure, cancellation, bounded concurrency, duplicate events, and restart recovery.
- The Electron workflow covers room creation, a real Git chooser result, chat, selection, editing, attribution, draft-only use, progress, per-agent inspection, successful and failed simulation, cancellation, sidebar shortcuts, minimum-size layout, reload, restart, and supervisor loss.
- Each workflow uses a new local profile and an empty committed Git fixture. Network logs must contain only packaged app assets; fixture Git status must stay clean. Screenshots, snapshots, and a JSON report are saved under `output/playwright/`.
- Development startup is checked through the actual Electron window with the browser-check CLI on loopback. No Supabase or Vercel APIs are called for validation.

The tests distinguish verification of desktop software, mock simulation, and explicitly invoked live Codex checks. Recorded foundation results below predate the Codex integration; see the runner guide for its validation procedure and current results.

### Historical standalone results

Final verification on 2026-09-04 (America/Los_Angeles): `pnpm check` passed, Windows packaging passed, and `pnpm test:desktop:packaged` passed all eleven workflow checkpoints against the packaged executable. The final run recorded zero unexpected runtime errors, zero external requests, and no fixture repository changes.

The packaged run's JSON report, completed workflow screenshot, minimum-window screenshot, and development screenshot are retained locally under the ignored `output/` directory. The development screenshot records a successful message sent through the Vite/Electron development path.

## Reference decisions

Electron boundaries follow the official [process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [security checklist](https://www.electronjs.org/docs/latest/tutorial/security), and [utility process API](https://www.electronjs.org/docs/latest/api/utility-process). The build uses [Vite](https://vite.dev/guide/) through Electron Vite, with Vite 7 selected to match Electron Vite 5's supported peer range.

## Monorepo configuration

Run all commands from the repository root. `pnpm check` validates both apps; `pnpm test:desktop:e2e` builds desktop and runs its three fixture UI suites sequentially. `pnpm test:desktop:packaged` packages before running the Windows workflow. Turbo caches desktop `out/**`, while tests and packaging execute without cache. Keep Node 24.14+, Electron 44.2.0 and Vite 7 compatible with electron-vite 5.

The shared fixture creates platform auth/role stubs and then loads every canonical application migration in order. `pnpm db:types` uses Supabase's type generator against that in-memory schema; `pnpm test` checks generated types for drift. Desktop package commands explicitly disable publishing. Windows uses `signExecutable: false`, retaining application metadata while leaving builds unsigned.

If Windows holds an existing release archive open, build and test a separate output directory without removing that archive:

```powershell
pnpm build:desktop
pnpm --filter @multiplayer-ai/desktop exec electron-builder --dir --publish never --config.directories.output=release/validation
pnpm --filter @multiplayer-ai/desktop test:packaged --packaged-dir release/validation/win-unpacked
```

The directory passed to `--packaged-dir` is relative to `apps/desktop` unless absolute. The default packaged test still uses `release/win-unpacked`.

## Monorepo verification: 2026-09-14

`pnpm install --frozen-lockfile` and `pnpm check` passed on Windows with Node 24.14.1 and pnpm 11.24.0. The combined checks ran 88 tests, verified generated schema types, and passed all workspace typechecks, lint checks and production builds. Web route test globs now include all 63 web tests on Windows.

The three desktop fixture suites passed 26 UI checkpoints. The fresh Windows package passed all 11 packaged checkpoints with no unexpected runtime errors or external requests. An unsigned NSIS installer was built successfully; installer execution and macOS/Linux packages were not tested. Windows executable metadata identifies Multiplayer AI version 0.1.0.

Turbo restored all seven desktop build files byte-for-byte from cache after moving the generated output to a backup. `pnpm dev:desktop` was verified through the actual Electron window: a local message survived reload and no browser errors occurred. `pnpm dev:web` served the sign-in page without browser errors or a framework error overlay. Screenshots were inspected at normal and minimum desktop sizes.

Codex held the imported `release/win-unpacked/resources/app.asar` open, so packaging validation used `apps/desktop/release/monorepo-validation` through the documented output override. No process belonging to the user's existing app was stopped. The normal output configuration remains `release`; close the process holding an old archive before replacing it.

Logs and reports are retained under ignored `output/`, including `monorepo-check-final.log`, `desktop-e2e.log`, `desktop-packaged-isolated-test.log`, `desktop-installer.log`, and `output/playwright/`. These results use local fixtures and do not establish live GitHub OAuth, remote database rollout, or live Codex execution.

## Shared UI verification: 2026-09-15

Both apps now consume the same `@multiplayer-ai/ui` source. Workspace typechecks, lint, production builds and frozen-lockfile installation passed. The combined unit/regression suites passed 93 tests, including the shared composer limits and encrypted-session file-lock regressions. Turbo's desktop build graph includes the shared UI source in its dependency hash.

Shared-component Chromium checks passed for default, compact and mobile layouts with a clean console. All 26 desktop fixture checkpoints and all 11 packaged checkpoints passed. Screenshots were inspected at normal, mobile and minimum desktop sizes. The actual Next.js sign-in page and Electron development window loaded without browser errors; a local message was sent through the shared composer in development mode.

The first shared-room run exposed a Windows `EPERM` while atomically replacing the encrypted session file. Auth storage now serializes asynchronous writes and retries transient rename locks for a bounded period, preserving the last persisted value on failure. The OAuth test waits for the intercepted browser handoff. The repeated shared-room suite verified encrypted-session restoration and account isolation.

An updated unsigned installer is under `apps/desktop/release/shared-ui-validation/Multiplayer AI Setup 0.1.0.exe`. Its adjacent `win-unpacked` executable passed the packaged suite. Installer execution and macOS/Linux packaging were not tested. Existing release directories were preserved. Logs are retained under ignored `output/shared-ui-*.log`; browser and Electron reports are in `output/playwright/`. The web room components were verified through shared UI fixtures and builds, without a live authenticated web session or model call.
