import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
    appDirectory,
    createRun,
    fixtureRepository,
    outputDirectory,
    testEnvironment,
} from "./e2e-support.mjs";
import { startProgramServer } from "./programs-fixture.mjs";

const packaged = process.argv.includes("--packaged");
const packagedDirectoryOption = process.argv.indexOf("--packaged-dir");
if (
    packagedDirectoryOption !== -1 &&
    (!packaged ||
        !process.argv[packagedDirectoryOption + 1] ||
        process.argv[packagedDirectoryOption + 1].startsWith("--"))
) {
    throw new Error("Use --packaged --packaged-dir <directory>.");
}
const defaultPackagedDirectory = {
    win32: "release/win-unpacked",
    darwin: `release/mac${process.arch === "arm64" ? "-arm64" : ""}`,
    linux: "release/linux-unpacked",
}[process.platform];
const packagedDirectory = resolve(
    appDirectory,
    packagedDirectoryOption === -1
        ? defaultPackagedDirectory
        : process.argv[packagedDirectoryOption + 1],
);
const packagedExecutable = {
    win32: join(packagedDirectory, "Multiplayer AI.exe"),
    darwin: join(
        packagedDirectory,
        "Multiplayer AI.app/Contents/MacOS/Multiplayer AI",
    ),
    linux: join(packagedDirectory, "multiplayer-ai-desktop"),
}[process.platform];
const output = await outputDirectory("");
const fixture = join(output, "fixture-repo");
const userData = join(output, "user-data");
const git = await fixtureRepository(fixture);
// Unpackaged runs use harness fixtures and a loopback download server; a packaged app ignores them.
const programs = packaged
    ? undefined
    : await startProgramServer(join(output, "manifest.json"));
let expectedConsoleErrors = false;
let security;

const run = createRun({
    output,
    environment: testEnvironment({
        MP_TEST_USER_DATA: userData,
        ...(packaged
            ? {}
            : {
                  MP_TEST_CODEX_FIXTURE: join(
                      appDirectory,
                      "scripts/codex-fixture.mjs",
                  ),
                  MP_TEST_CLAUDE_FIXTURE: join(output, "claude-fixture.json"),
                  MP_TEST_HARNESS_MANIFEST: join(output, "manifest.json"),
                  MP_FIXTURE_SIGNED_IN: "1",
                  MP_FIXTURE_STATE: join(output, "codex-threads.json"),
              }),
    }),
    timeout: 12_000,
    executablePath: packaged ? packagedExecutable : undefined,
    args: packaged ? [`--user-data-dir=${userData}`] : undefined,
    consoleErrors: () => !expectedConsoleErrors,
    stderrErrors: true,
});
const { launch, checkpoint, snapshot, selectRepository } = run;

await run.execute(
    async () => {
        await launch();
        const { application, page } = run;
        await page.screenshot({ path: join(output, "01-empty-desktop.png") });
        security = await application.evaluate(({ BrowserWindow }) => {
            const prefs =
                BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
            return {
                contextIsolation: prefs.contextIsolation,
                sandbox: prefs.sandbox,
                nodeIntegration: prefs.nodeIntegration,
                webSecurity: prefs.webSecurity,
            };
        });
        assert.deepEqual(security, {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
        });
        const exposed = await page.evaluate(() => ({
            require: typeof window.require,
            process: typeof window.process,
            keys: Object.keys(window.desktop).sort(),
        }));
        assert.equal(exposed.require, "undefined");
        assert.equal(exposed.process, "undefined");
        assert.deepEqual(
            exposed.keys,
            [
                "createRoom",
                "signIn",
                "signOut",
                "cancelSignIn",
                "refreshShared",
                "joinRoom",
                "createInvite",
                "createSuggestion",
                "editSuggestion",
                "getSnapshot",
                "onHealth",
                "onSnapshot",
                "onTranscript",
                "protocolVersion",
                "selectWorkspace",
                "sendMessage",
                "openTab",
                "renameTab",
                "closeTab",
                "setLoadout",
                "sendToTab",
                "stopTab",
                "reopenTab",
                "deleteClosedTab",
                "setReadAlong",
                "watchSharedTab",
                "unwatchSharedTab",
                "loadSharedTranscript",
                "onSharedTranscript",
                "loadTranscript",
                "loadAgents",
                "resetTabSession",
                "respondToTabApproval",
                "answerQuestion",
                "refreshHarness",
                "signInHarness",
                "chooseHarnessExecutable",
                "useManagedHarness",
                "acknowledgeHarnessNotice",
            ].sort(),
        );
        const malformed = await page.evaluate(async () => {
            const state = await window.desktop.getSnapshot();
            return window.desktop.sendToTab({
                roomId: state.snapshot.rooms[0].id,
                tabId: state.snapshot.rooms[0].id,
                text: "Invalid",
                command: "whoami",
            });
        });
        assert.deepEqual(malformed, {
            ok: false,
            error: "Invalid desktop request.",
        });
        await checkpoint("Electron renderer sandbox and narrow IPC bridge");

        await page
            .getByRole("button", { name: "New room", exact: true })
            .click();
        await page
            .getByRole("textbox", { name: "Room name", exact: true })
            .fill("Desktop validation");
        await page
            .getByRole("button", { name: "Create room", exact: true })
            .click();
        await page
            .getByRole("heading", { name: "Desktop validation", exact: true })
            .waitFor();
        await selectRepository(fixture);
        await checkpoint("Create room and select a real local Git repository");

        if (packaged) {
            // The Claude Code harness state exists only once the supervisor has loaded the Claude Agent
            // SDK, so reaching it proves the SDK loads from the packaged build.
            await page
                .getByRole("button", { name: "New tab", exact: true })
                .click();
            await page
                .getByRole("menuitem", { name: "Claude Code", exact: true })
                .click();
            await page.getByRole("tab", { name: /Claude Code 1/ }).waitFor();
            const state = await snapshot();
            assert.equal(state.rooms[1].tabs[0].status, "unavailable");
            assert.ok(
                ["missing", "downloading"].includes(
                    state.harnesses.find((harness) => harness.id === "claude")
                        .program.state,
                ),
            );
            await checkpoint(
                "A packaged Claude Code tab without a managed binary needs setup",
            );
            return;
        }

        await page
            .getByRole("textbox", { name: "Group chat message", exact: true })
            .fill(
                "Keep the existing UI components and verify keyboard navigation. FIXTURE_SUGGESTION_LOCK",
            );
        await page
            .getByRole("button", { name: "Send message", exact: true })
            .click();
        await page
            .getByRole("checkbox", {
                name: /Select message: Keep the existing/,
            })
            .click();
        await page
            .getByRole("button", { name: "Suggest prompts", exact: true })
            .click();
        await page
            .getByText(
                "Add a dark mode toggle, persist the selected theme, and verify it survives a restart.",
                { exact: true },
            )
            .waitFor();
        await page.screenshot({
            path: join(output, "generated-suggestion.png"),
        });
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await page
            .getByRole("textbox", {
                name: "Edit suggested prompt",
                exact: true,
            })
            .fill(
                "Preserve the panel architecture and verify keyboard navigation.",
            );
        await page
            .getByRole("button", { name: "Save edit", exact: true })
            .click();
        // Wait for the save acknowledgement; the editor already contains the new text.
        await page
            .getByRole("button", { name: "Save edit", exact: true })
            .waitFor({ state: "hidden" });
        await page
            .getByText(
                "Preserve the panel architecture and verify keyboard navigation.",
                { exact: true },
            )
            .waitFor();
        let state = await snapshot();
        assert.equal(
            state.rooms[1].suggestions[0].sources[0].authorName,
            "You",
        );
        assert.equal(state.rooms[1].suggestions[0].revision, 2);

        await page
            .getByRole("button", { name: "New tab", exact: true })
            .click();
        const picker = page.getByRole("menu", { name: "Open a new tab with" });
        // The menu must render outside the tab list's scroll box, not clipped by it.
        const box = await picker.boundingBox();
        assert.ok(box && box.height > 90, "New tab menu must be fully visible");
        await page.waitForTimeout(200); // Let the menu finish its fade-in.
        await page.screenshot({ path: join(output, "02-new-tab-menu.png") });
        await page.keyboard.press("Escape");
        assert.equal(await picker.count(), 0);
        await page
            .getByRole("button", { name: "New tab", exact: true })
            .click();
        await page
            .getByRole("menuitem", { name: "Codex", exact: true })
            .click();
        await page.getByRole("tab", { name: /Codex 1/ }).waitFor();
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await snapshot()).rooms[1].tabs[0].status === "idle") break;
            await page.waitForTimeout(100);
        }
        await page
            .getByRole("button", { name: "Use prompt", exact: true })
            .click();
        assert.equal(
            await page
                .getByRole("textbox", { name: "Message", exact: true })
                .inputValue(),
            "Preserve the panel architecture and verify keyboard navigation.",
        );
        state = await snapshot();
        assert.equal(
            state.rooms[1].suggestions[0].status,
            "draft",
            "Using a suggestion must not dispatch work",
        );
        await checkpoint(
            "Chat selection, persisted suggestion editing, attribution, and draft-only use",
        );

        const suggestions = page.getByRole("region", {
            name: "Prompt suggestions",
        });
        await suggestions
            .getByRole("button", { name: "Dismiss", exact: true })
            .click();
        assert.equal(
            await suggestions
                .getByRole("button", { name: "Use prompt" })
                .count(),
            0,
        );
        await suggestions
            .getByRole("button", { name: "Show 1 dismissed" })
            .click();
        await suggestions
            .getByRole("button", { name: "Restore", exact: true })
            .click();
        await suggestions.getByRole("button", { name: "Use prompt" }).waitFor();
        assert.equal((await snapshot()).rooms[1].suggestions.length, 1);
        await checkpoint(
            "Suggestions dismiss and restore on this desktop only",
        );

        const harnessToggle = page.getByRole("button", {
            name: /^Harnesses/,
        });
        await harnessToggle.click();
        assert.equal(
            await harnessToggle.getAttribute("aria-expanded"),
            "false",
        );
        assert.equal(
            await page
                .getByRole("region", { name: "Harness settings" })
                .count(),
            0,
        );
        await harnessToggle.click();
        await page.getByRole("region", { name: "Harness settings" }).waitFor();
        await checkpoint("Sidebar sections collapse and expand");

        await page.keyboard.press("Control+b");
        assert.equal(
            await page
                .getByRole("navigation", { name: "Rooms", exact: true })
                .count(),
            0,
        );
        await page.keyboard.press("Control+b");
        await page
            .getByRole("navigation", { name: "Rooms", exact: true })
            .waitFor();
        await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1024, 720),
        );
        const layout = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            panels: [
                ...document.querySelectorAll(".panel, .mission-panel"),
            ].map((panel) => ({
                height: panel.getBoundingClientRect().height,
                width: panel.getBoundingClientRect().width,
            })),
        }));
        assert.ok(
            layout.scrollWidth <= layout.width,
            "Window must not overflow horizontally",
        );
        assert.ok(
            layout.panels.every(
                (panel) => panel.height > 120 && panel.width > 200,
            ),
        );
        await page.screenshot({ path: join(output, "03-minimum-window.png") });
        await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1440, 960),
        );
        await checkpoint(
            "Keyboard sidebar toggle and usable panels at 1024 by 720",
        );

        await page.reload();
        await page
            .getByRole("heading", { name: "Desktop validation", exact: true })
            .waitFor();
        await page
            .getByRole("button", { name: "fixture-repo", exact: true })
            .waitFor();
        state = await snapshot();
        assert.equal(state.rooms[1].messages.length, 1);
        assert.equal(state.rooms[1].tabs[0].title, "Codex 1");
        await page.getByRole("tab", { name: /Codex 1/ }).waitFor();
        await checkpoint(
            "Reload reconciles persisted room, repository, chat, suggestions, and tabs",
        );

        // Killing only this application's utility process exercises stale state in the visible product.
        await application.evaluate(({ app }) => {
            const child = app
                .getAppMetrics()
                .find((metric) => metric.name === "Multiplayer AI Supervisor");
            if (!child)
                throw new Error(
                    "Supervisor process missing from application metrics",
                );
            process.kill(child.pid);
        });
        await page
            .getByRole("status")
            .filter({ hasText: "Progress is stale" })
            .waitFor();
        assert.equal(
            await page
                .getByRole("textbox", { name: "Message", exact: true })
                .isDisabled(),
            true,
        );
        await page.screenshot({
            path: join(output, "04-stale-supervisor.png"),
        });
        await checkpoint("Supervisor loss is visible and prevents dispatch");

        expectedConsoleErrors = true;
        const windowsBefore = application.windows().length;
        await page.evaluate(() =>
            window.open("https://example.invalid", "_blank"),
        );
        assert.equal(application.windows().length, windowsBefore);
        assert.equal(
            git("status", "--porcelain"),
            "",
            "The desktop must not alter the selected repository",
        );
        const remoteRequests = run.network.filter(
            (url) => !url.startsWith("multiplayer://desktop/"),
        );
        assert.deepEqual(
            remoteRequests,
            [],
            "No network requests outside packaged app assets are allowed",
        );
        assert.deepEqual(
            run.errors,
            [],
            "No unexpected renderer or main-process errors",
        );
        await checkpoint(
            "No remote requests, no repository changes, and no unexpected runtime errors",
        );
    },
    {
        cleanup: () => programs?.close(),
        extra: () => ({ security, network: run.network }),
    },
);
