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
                  // OpenCode finds no local server and has no login of its own here.
                  MP_TEST_OPENCODE_FIXTURE: join(
                      appDirectory,
                      "scripts/opencode-fixture.mjs",
                  ),
                  MP_OPENCODE_FIXTURE_LOG: join(output, "opencode.jsonl"),
                  XDG_DATA_HOME: join(output, "xdg-data"),
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
                "deleteRoom",
                "leaveRoom",
                "createInvite",
                "createSuggestion",
                "editSuggestion",
                "deleteSuggestion",
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
                "loadCommands",
                "resetTabSession",
                "respondToTabApproval",
                "answerQuestion",
                "refreshHarness",
                "signInHarness",
                "cancelHarnessSignIn",
                "signOutHarness",
                "chooseHarnessExecutable",
                "useManagedHarness",
                "acknowledgeHarnessNotice",
                "setNewTabHarness",
                "setHarnessDefault",
                "setHarnessModelHidden",
                "setHarnessOutputStyle",
                "updateHarness",
                "revertHarnessUpdate",
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

        const addRoom = page.getByRole("button", {
            name: "Add room",
            exact: true,
        });
        await addRoom.click();
        const dialog = page.getByRole("dialog", {
            name: "Add room",
            exact: true,
        });
        const roomName = dialog.getByRole("textbox", {
            name: "Room name",
            exact: true,
        });
        await run.until(
            () =>
                roomName.evaluate((input) => input === document.activeElement),
            "room name focus",
        );
        assert.equal(
            await dialog
                .getByRole("button", { name: "Create room", exact: true })
                .isDisabled(),
            true,
        );
        assert.equal(
            await dialog
                .getByRole("combobox", { name: "Room visibility" })
                .inputValue(),
            "local",
        );
        await roomName.fill("Draft room");
        await dialog
            .getByRole("button", { name: "Join with invite", exact: true })
            .click();
        await dialog
            .getByRole("textbox", { name: "Invitation code" })
            .fill("saved invite draft");
        assert.equal(
            await dialog
                .getByRole("button", { name: "Join room", exact: true })
                .isDisabled(),
            true,
        );
        await dialog
            .getByRole("button", { name: "Sign in with GitHub" })
            .waitFor();
        await page.screenshot({
            path: join(output, "room-join-signed-out.png"),
            animations: "disabled",
        });
        await dialog
            .getByRole("button", { name: "Create", exact: true })
            .click();
        assert.equal(await roomName.inputValue(), "Draft room");
        await dialog
            .getByRole("combobox", { name: "Room visibility" })
            .selectOption("shared");
        await dialog
            .getByRole("button", { name: "Sign in with GitHub" })
            .waitFor();
        assert.equal(
            await dialog
                .getByRole("button", { name: "Create room", exact: true })
                .isDisabled(),
            true,
        );
        await dialog
            .getByRole("combobox", { name: "Room visibility" })
            .selectOption("local");
        await dialog
            .getByRole("button", { name: "Join with invite", exact: true })
            .click();
        assert.equal(
            await dialog
                .getByRole("textbox", { name: "Invitation code" })
                .inputValue(),
            "saved invite draft",
        );
        await dialog
            .getByRole("button", { name: "Create", exact: true })
            .click();
        // Tab wraps inside the dialog; the app's sidebar shortcut must not remove its trigger.
        await dialog
            .getByRole("button", { name: "Close", exact: true })
            .focus();
        await page.keyboard.press("Tab");
        // Tab first lands on the dialog's focus guard, which hands focus back to the first
        // control a moment later.
        await run.until(
            () =>
                dialog
                    .getByRole("button", { name: "Create", exact: true })
                    .evaluate((button) => button === document.activeElement),
            "Tab wraps to the dialog's first control",
        );
        await page.keyboard.press("Control+b");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await run.until(
            () =>
                addRoom.evaluate((button) => button === document.activeElement),
            "focus returns to Add room",
        );
        await addRoom.click();
        assert.equal(await roomName.inputValue(), "");
        await dialog
            .getByRole("button", { name: "Join with invite", exact: true })
            .click();
        assert.equal(
            await dialog
                .getByRole("textbox", { name: "Invitation code" })
                .inputValue(),
            "",
        );
        await dialog
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        await dialog.waitFor({ state: "hidden" });
        await addRoom.click();
        await page
            .locator('[data-slot="dialog-overlay"]')
            .click({ position: { x: 5, y: 5 } });
        await dialog.waitFor({ state: "hidden" });
        await addRoom.click();
        await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1024, 720),
        );
        await page.screenshot({
            path: join(output, "room-create-minimum-window.png"),
            animations: "disabled",
        });
        const dialogBox = await dialog.boundingBox();
        const viewport = await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
        }));
        assert.ok(
            dialogBox.width >= 400 && dialogBox.x >= 0 && dialogBox.y >= 0,
        );
        assert.ok(
            dialogBox.x + dialogBox.width <= viewport.width &&
                dialogBox.y + dialogBox.height <= viewport.height,
        );
        await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1440, 960),
        );
        await checkpoint(
            "Room modal preserves mode drafts, resets on dismissal, traps and restores focus, and fits the minimum window",
        );
        await page
            .getByRole("textbox", { name: "Room name", exact: true })
            .fill("Desktop validation");
        await page
            .getByRole("button", { name: "Create room", exact: true })
            .click();
        await page
            .getByRole("heading", { name: "Desktop validation", exact: true })
            .waitFor();
        await dialog.waitFor({ state: "hidden" });
        await selectRepository(fixture);
        await checkpoint("Create room and select a real local Git repository");

        if (packaged) {
            // The Claude Code harness state exists only once the supervisor has loaded the Claude Agent
            // SDK, so reaching it proves the SDK loads from the packaged build.
            await run.newTab("Claude Code");
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
        await run.newTab("Codex");
        await page.getByRole("tab", { name: /Codex 1/ }).waitFor();
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await snapshot()).rooms[1].tabs[0].status === "idle") break;
            await page.waitForTimeout(100);
        }
        // Only the transcript and chat messages select text, one region at a time.
        const selectable = (selector) =>
            page.evaluate(
                (target) =>
                    getComputedStyle(document.querySelector(target)).userSelect,
                selector,
            );
        assert.equal(await selectable(".sidebar"), "none");
        await page.locator(".chat-messages").click({ position: { x: 5, y: 5 } });
        assert.equal(await selectable(".chat-messages"), "text");
        assert.equal(await selectable(".transcript"), "none");
        await page.locator(".transcript").click({ position: { x: 5, y: 5 } });
        assert.equal(await selectable(".transcript"), "text");
        assert.equal(await selectable(".chat-messages"), "none");
        // A leading slash lists the harness's commands; Enter completes the picked one.
        const prompt = page.getByRole("textbox", {
            name: "Message",
            exact: true,
        });
        await prompt.fill("/rev");
        const commands = page.getByRole("listbox", { name: "Commands" });
        await commands.getByRole("option", { name: /\/review/ }).waitFor();
        await page.screenshot({ path: join(output, "02-slash-commands.png") });
        await prompt.press("Enter");
        assert.equal(await prompt.inputValue(), "/review ");
        assert.equal(await commands.count(), 0);
        assert.equal(
            (await snapshot()).rooms[1].tabs[0].status,
            "idle",
            "Completing a command must not send it",
        );
        await prompt.fill("");
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
            .getByRole("button", { name: "Delete", exact: true })
            .click();
        await suggestions
            .getByRole("button", { name: "Use prompt" })
            .waitFor({ state: "hidden" });
        assert.equal((await snapshot()).rooms[1].suggestions.length, 0);
        await checkpoint("Deleting a suggestion removes it from the room");

        const roomsToggle = page.getByRole("button", {
            name: /^Rooms/,
        });
        await roomsToggle.click();
        assert.equal(
            await roomsToggle.getAttribute("aria-expanded"),
            "false",
        );
        await roomsToggle.click();
        assert.equal(
            await roomsToggle.getAttribute("aria-expanded"),
            "true",
        );
        await checkpoint("Sidebar sections collapse and expand");

        // Rooms reorder with Alt+Up/Down (and drag); the order stays on this desktop.
        const roomNames = async () =>
            (
                await page
                    .getByRole("navigation", { name: "Rooms" })
                    .locator(":scope > button")
                    .allInnerTexts()
            ).map((text) => text.trim());
        const initialRooms = await roomNames();
        await page
            .getByRole("navigation", { name: "Rooms" })
            .getByRole("button", { name: initialRooms[0], exact: true })
            .press("Alt+ArrowDown");
        assert.deepEqual(await roomNames(), [
            initialRooms[1],
            initialRooms[0],
            ...initialRooms.slice(2),
        ]);
        await page
            .getByRole("navigation", { name: "Rooms" })
            .getByRole("button", { name: initialRooms[0], exact: true })
            .press("Alt+ArrowUp");
        assert.deepEqual(await roomNames(), initialRooms);
        await checkpoint("Rooms reorder from the keyboard");

        // Back and forward retrace the rooms shown, from the header and the keyboard.
        const roomsNav = page.getByRole("navigation", { name: "Rooms" });
        const currentRoom = async () =>
            (
                await roomsNav.locator('button[aria-current="page"]').innerText()
            ).trim();
        const startRoom = await currentRoom();
        const otherRoom = initialRooms.find((name) => name !== startRoom);
        await roomsNav.getByRole("button", { name: otherRoom, exact: true }).click();
        assert.equal(await currentRoom(), otherRoom);
        await page.getByRole("button", { name: "Back", exact: true }).click();
        assert.equal(await currentRoom(), startRoom);
        assert.equal(
            await page
                .getByRole("button", { name: "Forward", exact: true })
                .isEnabled(),
            true,
        );
        await page.keyboard.press("Control+]");
        assert.equal(await currentRoom(), otherRoom);
        await page.keyboard.press("Control+[");
        assert.equal(await currentRoom(), startRoom);
        await checkpoint("Back and forward retrace rooms");

        // Signed out, the footer offers sign-in and the header stays quiet.
        await page
            .locator(".sidebar-footer")
            .getByText("Not signed in", { exact: true })
            .waitFor();
        assert.equal(
            (await page.locator(".app-bar .connection").innerText()).trim(),
            "",
        );

        // Harness setup lives in Settings, not the sidebar.
        assert.equal(
            await page.getByRole("region", { name: "Harness settings" }).count(),
            0,
        );
        const settingsButton = page.getByRole("button", {
            name: "Settings",
            exact: true,
        });
        await settingsButton.click();
        const settingsDialog = page.getByRole("dialog", { name: "Settings" });
        await settingsDialog.getByRole("tab", { name: "Codex" }).click();
        await settingsDialog
            .getByRole("region", { name: "Harness settings" })
            .getByText(/fixture@example.invalid/)
            .waitFor();
        const shown = settingsDialog.getByRole("switch", {
            name: /in the model picker/,
        });
        assert.ok((await shown.count()) > 0, "Settings lists Codex models");
        // The default model always stays in the picker.
        assert.equal(await shown.first().isDisabled(), true);
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(output, "03-settings.png") });
        await settingsDialog.getByRole("tab", { name: "Claude Code" }).click();
        await settingsDialog
            .getByRole("button", { name: "Refresh Claude Code", exact: true })
            .waitFor();
        if (!packaged) {
            // With no usable model OpenCode says so and shows how to get one.
            await settingsDialog.getByRole("tab", { name: "OpenCode" }).click();
            await settingsDialog
                .getByRole("button", { name: "Refresh OpenCode", exact: true })
                .click();
            const opencode = settingsDialog.getByRole("region", {
                name: "Harness settings",
            });
            await opencode
                .getByText("No models available", { exact: true })
                .waitFor({ timeout: 30_000 });
            await opencode.getByText(/ollama launch opencode/).waitFor();
            await opencode.getByText("Ollama · not running").waitFor();
            assert.equal(
                await opencode.getByRole("button", { name: /Sign in/ }).count(),
                0,
            );
            await page.screenshot({ path: join(output, "03-opencode-no-models.png") });
        }
        await page.keyboard.press("Escape");
        assert.equal(await settingsDialog.count(), 0);
        await checkpoint(
            packaged
                ? "Settings shows harness connections and models"
                : "Settings shows harness connections and models, and OpenCode with none says so",
        );

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
            .locator('.desktop-shell[data-health="stale"] .stale-banner')
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
