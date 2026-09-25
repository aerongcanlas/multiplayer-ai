import {
  isHarnessCommand,
  type Command,
  type PrivateWorkspace,
  type Result,
  type Snapshot,
  type SupervisorRequest,
} from "../shared/contracts";
import type { CollaborationClient } from "./collaboration-client";
import { tabBusy, type HarnessId, type TranscriptPage } from "../shared/tabs";

// Commands that start work wait on shared-room checks; everything else reaches the supervisor
// directly so Stop and responses work while the shared connection is down.
const DIRECT = new Set([
  "tab.stop",
  "tab.close",
  "tab.rename",
  "tab.transcript",
  "tab.agents",
  "tab.resetSession",
  "approval.respond",
  "question.answer",
]);

interface Supervisor {
  request(command: SupervisorRequest["command"]): Promise<Result>;
}

/** Project only the current account's current memberships over this host's private execution history. */
export class DesktopCoordinator {
  private local?: Snapshot;
  private view?: Snapshot;
  private revision = 0;
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
    const sharedRooms = this.shared.rooms.map((remote) => {
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
    };
    this.publish(this.view);
    // A revoked membership or sign-out also stops running tabs associated with that account.
    for (const room of this.local.rooms.filter(
      (room) => room.shared && !sharedRooms.some((item) => item.id === room.id),
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
    try {
      if (!this.local) await this.localCommand({ type: "snapshot" });
      let notice: Extract<Result, { ok: true }>["notice"];
      let transcript: TranscriptPage | undefined;
      if (command.type === "harness.chooseExecutable") {
        // The path comes from main's native dialog, never from the renderer.
        const path = await this.chooseExecutable(command.harness);
        if (path)
          await this.localCommand({
            type: "harness.setExecutable",
            harness: command.harness,
            path,
          });
      } else if (isHarnessCommand(command)) await this.localCommand(command);
      else if (command.type === "auth.signIn") await this.shared.signIn();
      else if (command.type === "auth.signOut") await this.shared.signOut();
      else if (command.type === "auth.cancel") await this.shared.cancelSignIn();
      else if (command.type === "shared.refresh") await this.shared.refresh();
      else if (command.type === "snapshot") {
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
        let room = this.view!.rooms.find((room) => room.id === command.roomId);
        if (!room)
          throw new Error("Room unavailable. Refresh your shared rooms.");
        if (
          room.shared &&
          [
            "message.send",
            "suggestion.create",
            "suggestion.edit",
            "invite.create",
          ].includes(command.type)
        ) {
          notice = await this.shared.command(command);
        } else {
          if (command.type === "invite.create")
            throw new Error("Invitations are available in shared rooms.");
          if (room.shared && !DIRECT.has(command.type)) {
            await this.shared.refresh();
            room = this.shared.rooms.find((item) => item.id === command.roomId);
            if (!room || this.shared.state.status !== "connected")
              throw new Error(
                "Reconnect and confirm room membership before running locally.",
              );
            await this.localCommand({ type: "shared.import", room });
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
                    item.shared?.userId === room!.shared?.userId,
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
                  item.shared?.userId === room!.shared?.userId,
              )
            )
              throw new Error("Room membership changed.");
            // Direct commands skip shared.import, so the supervisor's copy must be this account's.
            const held = this.local!.rooms.find((item) => item.id === room!.id);
            if (
              room.shared &&
              (held?.shared?.userId !== room.shared.userId ||
                held?.shared?.project !== room.shared.project)
            )
              throw new Error("Room membership changed.");
            transcript = (await this.localCommand(command)).transcript;
          }
        }
      }
      return {
        ok: true,
        snapshot: this.view!,
        ...(notice ? { notice } : {}),
        ...(transcript ? { transcript } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Desktop operation failed.",
      };
    }
  }
}
