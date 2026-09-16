import type {
  Command,
  PrivateWorkspace,
  Result,
  Snapshot,
  SupervisorRequest,
} from "../shared/contracts";
import type { CollaborationClient } from "./collaboration-client";

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
            executions: cached.executions,
            summaries: cached.summaries,
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
    // A revoked membership or sign-out also stops any local run associated with that account.
    for (const room of this.local.rooms.filter(
      (room) => room.shared && !sharedRooms.some((item) => item.id === room.id),
    )) {
      for (const run of room.executions.filter(
        (run) => run.status === "running",
      )) {
        void this.supervisor.request({
          type: "execution.stop",
          roomId: room.id,
          executionId: run.id,
        });
      }
    }
  }
  private async localCommand(command: SupervisorRequest["command"]) {
    const result = await this.supervisor.request(command);
    if (!result.ok) throw new Error(result.error);
    this.acceptLocal(result.snapshot);
  }
  async dispatch(command: Command): Promise<Result> {
    try {
      if (!this.local) await this.localCommand({ type: "snapshot" });
      let notice: Extract<Result, { ok: true }>["notice"];
      if (
        command.type === "provider.refresh" ||
        command.type === "provider.connect" ||
        command.type === "provider.cancel" ||
        command.type === "provider.disconnect"
      )
        await this.localCommand(command);
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
          if (room.shared && command.type !== "execution.stop") {
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
            await this.localCommand(command);
          }
        }
      }
      return { ok: true, snapshot: this.view!, ...(notice ? { notice } : {}) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Desktop operation failed.",
      };
    }
  }
}
