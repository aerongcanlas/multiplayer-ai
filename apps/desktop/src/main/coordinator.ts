import {
    isHarnessCommand,
    type Command,
    type PrivateWorkspace,
    type Result,
    type Snapshot,
    type SupervisorRequest,
} from "../shared/contracts";
import {
    tabBusy,
    type HarnessId,
    type SlashCommand,
    type TranscriptPage,
} from "../shared/tabs";
import type { CollaborationClient } from "./collaboration-client";

// Commands that start work wait on shared-room checks; everything else reaches the supervisor
// directly so Stop and responses work while the shared connection is down.
const DIRECT = new Set([
    "tab.stop",
    "tab.close",
    "tab.rename",
    "tab.transcript",
    "tab.agents",
    "tab.commands",
    "tab.resetSession",
    // Deleting a closed chat touches only this desktop's journal.
    "tab.delete",
    "approval.respond",
    "question.answer",
]);
// Turning read-along off never waits on the network, so an offline host can always stop sharing.
const isDirect = (command: Command) =>
    DIRECT.has(command.type) ||
    (command.type === "tab.setReadAlong" && !command.on);

interface Supervisor {
    request(command: SupervisorRequest["command"]): Promise<Result>;
}

/** Project only the current account's current memberships over this host's private execution history. */
export class DesktopCoordinator {
    private local?: Snapshot;
    private view?: Snapshot;
    private revision = 0;
    private suggesting = false;
    // The read-along publisher's per-tab status, shown by the host's switch.
    readAlongStatus?: () => NonNullable<Snapshot["readAlong"]>;
    // Main's viewer for other hosts' read-along tabs.
    viewer?: {
        watch(roomId: string, tabId: string): Promise<void>;
        unwatch(): void;
        loadEarlier(
            roomId: string,
            tabId: string,
            beforeSeq: number,
        ): Promise<void>;
    };
    constructor(
        private supervisor: Supervisor,
        private shared: Pick<
            CollaborationClient,
            | "rooms"
            | "state"
            | "command"
            | "refresh"
            | "signIn"
            | "signOut"
            | "cancelSignIn"
        >,
        private publish: (snapshot: Snapshot) => void,
        private chooseWorkspace: () => Promise<PrivateWorkspace | null>,
        private chooseExecutable: (
            harness: HarnessId,
        ) => Promise<string | null> = async () => null,
    ) {}
    acceptLocal(snapshot: Snapshot) {
        if (this.local && snapshot.revision < this.local.revision) return;
        this.local = snapshot;
        this.changed();
    }
    snapshot() {
        return this.view;
    }
    changed() {
        if (!this.local) return;
        const account = this.shared.state.account?.id;
        const sharedRooms = this.shared.rooms.map((remote) => {
            // This desktop's own rows never list; this account's other desktops are labelled.
            if (remote.shared?.sharedTabs)
                remote = {
                    ...remote,
                    shared: {
                        ...remote.shared,
                        sharedTabs: remote.shared.sharedTabs
                            .filter(
                                (tab) =>
                                    !(
                                        tab.hostId === account &&
                                        tab.deviceId === this.local!.hostId
                                    ),
                            )
                            .map((tab) =>
                                tab.hostId === account
                                    ? { ...tab, sameUser: true }
                                    : tab,
                            ),
                    },
                };
            const cached = this.local!.rooms.find(
                (room) =>
                    room.id === remote.id &&
                    room.shared?.userId === remote.shared?.userId &&
                    room.shared?.project === remote.shared?.project,
            );
            return cached
                ? {
                      ...remote,
                      workspace: cached.workspace,
                      tabs: cached.tabs,
                      closedTabs: cached.closedTabs,
                  }
                : remote;
        });
        this.view = {
            ...this.local,
            revision: ++this.revision,
            rooms: [
                ...this.local.rooms.filter((room) => !room.shared),
                ...sharedRooms,
            ],
            collaboration: structuredClone(this.shared.state),
            ...(this.readAlongStatus
                ? { readAlong: this.readAlongStatus() }
                : {}),
        };
        this.publish(this.view);
        // A revoked membership or sign-out also stops running tabs associated with that account.
        for (const room of this.local.rooms.filter(
            (room) =>
                room.shared && !sharedRooms.some((item) => item.id === room.id),
        )) {
            for (const tab of room.tabs.filter(
                (tab) => tabBusy(tab.status) || tab.runningAgents,
            ))
                void this.supervisor.request({
                    type: "tab.stop",
                    roomId: room.id,
                    tabId: tab.id,
                });
        }
    }
    private async localCommand(command: SupervisorRequest["command"]) {
        const result = await this.supervisor.request(command);
        if (!result.ok) throw new Error(result.error);
        this.acceptLocal(result.snapshot);
        return result;
    }
    async dispatch(command: Command): Promise<Result> {
        if (command.type === "suggestion.create" && this.suggesting)
            return {
                ok: false,
                error: "Prompt generation is already in progress.",
            };
        if (command.type === "suggestion.create") this.suggesting = true;
        try {
            if (!this.local) await this.localCommand({ type: "snapshot" });
            let notice: Extract<Result, { ok: true }>["notice"];
            let transcript: TranscriptPage | undefined;
            let commands: SlashCommand[] | undefined;
            if (command.type === "harness.chooseExecutable") {
                // The path comes from main's native dialog, never from the renderer.
                const path = await this.chooseExecutable(command.harness);
                if (path)
                    await this.localCommand({
                        type: "harness.setExecutable",
                        harness: command.harness,
                        path,
                    });
            } else if (isHarnessCommand(command))
                await this.localCommand(command);
            else if (command.type === "auth.signIn") await this.shared.signIn();
            else if (command.type === "auth.signOut")
                await this.shared.signOut();
            else if (command.type === "auth.cancel")
                await this.shared.cancelSignIn();
            else if (command.type === "shared.refresh")
                await this.shared.refresh();
            else if (command.type === "sharedTab.watch") {
                if (!this.viewer) throw new Error("Read-along is unavailable.");
                await this.viewer.watch(command.roomId, command.tabId);
            } else if (command.type === "sharedTab.unwatch")
                this.viewer?.unwatch();
            else if (command.type === "sharedTab.load") {
                if (!this.viewer) throw new Error("Read-along is unavailable.");
                await this.viewer.loadEarlier(
                    command.roomId,
                    command.tabId,
                    command.beforeSeq,
                );
            } else if (command.type === "snapshot") {
                /* Return the current projection. */
            } else if (
                command.type === "room.join" ||
                (command.type === "room.create" && command.scope === "shared")
            ) {
                notice = await this.shared.command(command);
            } else if (command.type === "room.create") {
                await this.localCommand(command);
                notice = { kind: "room", roomId: this.local!.rooms.at(-1)!.id };
            } else {
                let room = this.view!.rooms.find(
                    (room) => room.id === command.roomId,
                );
                if (!room)
                    throw new Error(
                        "Room unavailable. Refresh your shared rooms.",
                    );
                if (room.shared && command.type === "suggestion.create") {
                    const identity = room.shared;
                    await this.shared.refresh();
                    room = this.shared.rooms.find(
                        (item) => item.id === command.roomId,
                    );
                    if (
                        !room ||
                        room.shared?.userId !== identity.userId ||
                        room.shared.project !== identity.project ||
                        this.shared.state.status !== "connected"
                    )
                        throw new Error(
                            "Reconnect and confirm room membership before generating suggestions.",
                        );
                    const existing = new Set(
                        room.suggestions.map((item) => item.id),
                    );
                    await this.localCommand({
                        type: "shared.import",
                        room: {
                            ...room,
                            shared: { ...room.shared!, sharedTabs: undefined },
                        },
                    });
                    const generated = await this.localCommand(command);
                    if (
                        this.shared.state.account?.id !== identity.userId ||
                        !this.shared.rooms.some(
                            (item) =>
                                item.id === room!.id &&
                                item.shared?.userId === identity.userId &&
                                item.shared?.project === identity.project,
                        )
                    )
                        throw new Error(
                            "Room membership or account changed. Generate suggestions again.",
                        );
                    const prompts = generated.snapshot.rooms
                        .find((item) => item.id === room!.id)!
                        .suggestions.filter((item) => !existing.has(item.id))
                        .map((item) => item.prompt);
                    notice = await this.shared.command(command, prompts);
                } else if (
                    room.shared &&
                    [
                        "message.send",
                        "suggestion.edit",
                        "suggestion.delete",
                        "invite.create",
                    ].includes(command.type)
                ) {
                    notice = await this.shared.command(command);
                } else {
                    if (command.type === "invite.create")
                        throw new Error(
                            "Invitations are available in shared rooms.",
                        );
                    if (
                        command.type === "tab.setReadAlong" &&
                        command.on &&
                        !room.shared
                    )
                        throw new Error("Read-along needs a shared room.");
                    if (room.shared && !isDirect(command)) {
                        await this.shared.refresh();
                        room = this.shared.rooms.find(
                            (item) => item.id === command.roomId,
                        );
                        if (!room || this.shared.state.status !== "connected")
                            throw new Error(
                                "Reconnect and confirm room membership before running locally.",
                            );
                        // Other hosts' read-along tabs stay in main; the journal never stores them.
                        await this.localCommand({
                            type: "shared.import",
                            room: {
                                ...room,
                                shared: {
                                    ...room.shared!,
                                    sharedTabs: undefined,
                                },
                            },
                        });
                    }
                    if (command.type === "workspace.select") {
                        const workspace = await this.chooseWorkspace();
                        if (workspace) {
                            // Membership/account may have changed while the native dialog was open.
                            if (
                                room.shared &&
                                !this.view!.rooms.some(
                                    (item) =>
                                        item.id === room!.id &&
                                        item.shared?.userId ===
                                            room!.shared?.userId,
                                )
                            )
                                throw new Error("Room membership changed.");
                            await this.localCommand({
                                type: "workspace.register",
                                roomId: command.roomId,
                                workspace,
                            });
                        }
                    } else {
                        if (
                            room.shared &&
                            !this.view!.rooms.some(
                                (item) =>
                                    item.id === room!.id &&
                                    item.shared?.userId ===
                                        room!.shared?.userId,
                            )
                        )
                            throw new Error("Room membership changed.");
                        // Direct commands skip shared.import, so the supervisor's copy must be this account's.
                        const held = this.local!.rooms.find(
                            (item) => item.id === room!.id,
                        );
                        if (
                            room.shared &&
                            (held?.shared?.userId !== room.shared.userId ||
                                held?.shared?.project !== room.shared.project)
                        )
                            throw new Error("Room membership changed.");
                        ({ transcript, commands } =
                            await this.localCommand(command));
                    }
                }
            }
            return {
                ok: true,
                snapshot: this.view!,
                ...(notice ? { notice } : {}),
                ...(transcript ? { transcript } : {}),
                ...(commands ? { commands } : {}),
            };
        } catch (error) {
            return {
                ok: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Desktop operation failed.",
            };
        } finally {
            if (command.type === "suggestion.create") this.suggesting = false;
        }
    }
}
