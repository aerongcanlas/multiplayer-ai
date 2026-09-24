import { contextBridge, ipcRenderer } from "electron";
import {
  PROTOCOL_VERSION,
  COMMAND_CHANNEL,
  SNAPSHOT_CHANNEL,
  HEALTH_CHANNEL,
  TRANSCRIPT_CHANNEL,
} from "../shared/channels";
import type {
  Command,
  DesktopBridge,
  Health,
  Result,
  Snapshot,
} from "../shared/contracts";
import type { TranscriptBatch } from "../shared/tabs";

const invoke = (command: Command): Promise<Result> =>
  ipcRenderer.invoke(COMMAND_CHANNEL, command);
const bridge: DesktopBridge = {
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
  openTab: (roomId, harness) => invoke({ type: "tab.open", roomId, harness }),
  renameTab: (roomId, tabId, title) =>
    invoke({ type: "tab.rename", roomId, tabId, title }),
  closeTab: (roomId, tabId, confirm) =>
    invoke({
      type: "tab.close",
      roomId,
      tabId,
      ...(confirm ? { confirm: true as const } : {}),
    }),
  setLoadout: (roomId, tabId, loadout) =>
    invoke({ type: "tab.setLoadout", roomId, tabId, loadout }),
  sendToTab: (input) => invoke({ ...input, type: "tab.send" }),
  stopTab: (roomId, tabId) => invoke({ type: "tab.stop", roomId, tabId }),
  loadTranscript: (roomId, tabId, beforeSeq) =>
    invoke({
      type: "tab.transcript",
      roomId,
      tabId,
      ...(beforeSeq ? { beforeSeq } : {}),
    }),
  resetTabSession: (roomId, tabId) =>
    invoke({ type: "tab.resetSession", roomId, tabId }),
  respondToTabApproval: (roomId, tabId, approvalId, decision) =>
    invoke({ type: "approval.respond", roomId, tabId, approvalId, decision }),
  answerQuestion: (roomId, tabId, questionId, answers) =>
    invoke({ type: "question.answer", roomId, tabId, questionId, answers }),
  refreshHarness: (harness) => invoke({ type: "harness.refresh", harness }),
  signInHarness: (harness) => invoke({ type: "harness.signIn", harness }),
  chooseHarnessExecutable: (harness) =>
    invoke({ type: "harness.chooseExecutable", harness }),
  useManagedHarness: (harness) =>
    invoke({ type: "harness.useManaged", harness }),
  acknowledgeHarnessNotice: (harness) =>
    invoke({ type: "harness.acknowledgeNotice", harness }),
  onTranscript: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      batches: TranscriptBatch[],
    ) => listener(batches);
    ipcRenderer.on(TRANSCRIPT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(TRANSCRIPT_CHANNEL, handler);
  },
};
contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));
