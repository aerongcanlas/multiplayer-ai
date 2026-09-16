import { contextBridge, ipcRenderer } from "electron";
import {
  PROTOCOL_VERSION,
  COMMAND_CHANNEL,
  SNAPSHOT_CHANNEL,
  HEALTH_CHANNEL,
} from "../shared/channels";
import type {
  Command,
  DesktopBridge,
  Health,
  Result,
  Snapshot,
} from "../shared/contracts";

const invoke = (command: Command): Promise<Result> =>
  ipcRenderer.invoke(COMMAND_CHANNEL, command);
const bridge: DesktopBridge = {
  refreshProvider: () => invoke({ type: "provider.refresh" }),
  connectProvider: () => invoke({ type: "provider.connect" }),
  cancelProviderLogin: () => invoke({ type: "provider.cancel" }),
  disconnectProvider: () => invoke({ type: "provider.disconnect" }),
  respondToApproval: (roomId, executionId, approvalId, decision) =>
    invoke({
      type: "approval.respond",
      roomId,
      executionId,
      approvalId,
      decision,
    }),
  protocolVersion: PROTOCOL_VERSION,
  getSnapshot: () => invoke({ type: "snapshot" }),
  createRoom: (name, scope) => invoke({ type: "room.create", name, scope }),
  signIn: () => invoke({ type: "auth.signIn" }),
  cancelSignIn: () => invoke({ type: "auth.cancel" }),
  signOut: () => invoke({ type: "auth.signOut" }),
  refreshShared: () => invoke({ type: "shared.refresh" }),
  joinRoom: (token) => invoke({ type: "room.join", token }),
  createInvite: (roomId) => invoke({ type: "invite.create", roomId }),
  selectWorkspace: (roomId) => invoke({ type: "workspace.select", roomId }),
  sendMessage: (roomId, text) => invoke({ type: "message.send", roomId, text }),
  createSuggestion: (roomId, messageIds) =>
    invoke({ type: "suggestion.create", roomId, messageIds }),
  editSuggestion: (roomId, suggestionId, prompt, expectedRevision) =>
    invoke({
      type: "suggestion.edit",
      roomId,
      suggestionId,
      prompt,
      expectedRevision,
    }),
  startExecution: (input) => invoke({ ...input, type: "execution.start" }),
  stopExecution: (roomId, executionId) =>
    invoke({ type: "execution.stop", roomId, executionId }),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) =>
      listener(snapshot);
    ipcRenderer.on(SNAPSHOT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(SNAPSHOT_CHANNEL, handler);
  },
  onHealth: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, health: Health) =>
      listener(health);
    ipcRenderer.on(HEALTH_CHANNEL, handler);
    return () => ipcRenderer.removeListener(HEALTH_CHANNEL, handler);
  },
};
contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));
