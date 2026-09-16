import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  safeStorage,
  shell,
} from "electron";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  commandSchema,
  COMMAND_CHANNEL,
  SNAPSHOT_CHANNEL,
  HEALTH_CHANNEL,
  type Result,
} from "../shared/contracts";
import { isLocalDevUrl, isTrustedDocument } from "../shared/security";
import { inspectWorkspace } from "../supervisor/workspace";
import { SupervisorClient } from "./supervisor-client";
import { AuthStorage } from "./auth-storage";
import { CollaborationClient } from "./collaboration-client";
import { DesktopCoordinator } from "./coordinator";
import supabaseConfig from "../../config/supabase.json";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "multiplayer",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const testing = !app.isPackaged && process.env.MP_E2E === "1";
const profileDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (profileDirectory) app.setPath("userData", resolve(profileDirectory));
if (testing && process.env.MP_TEST_USER_DATA)
  app.setPath("userData", resolve(process.env.MP_TEST_USER_DATA));
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (devUrl && !isLocalDevUrl(devUrl))
  throw new Error("Development UI must be served from 127.0.0.1.");
const documentUrl = devUrl
  ? new URL(devUrl).href
  : "multiplayer://desktop/index.html";
let window: BrowserWindow | null = null;
let supervisor: SupervisorClient;
let collaboration: CollaborationClient;
let coordinator: DesktopCoordinator;

function createWindow() {
  window = new BrowserWindow({
    title: "Multiplayer AI",
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#171717",
    show: !testing,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("did-finish-load", () => {
    const snapshot = coordinator.snapshot();
    if (snapshot) window?.webContents.send(SNAPSHOT_CHANNEL, snapshot);
    window?.webContents.send(HEALTH_CHANNEL, supervisor.getHealth());
  });
  window.on("closed", () => {
    window = null;
  });
  void window.loadURL(documentUrl);
}

if (!testing && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app.whenReady().then(() => {
    const rendererRoot = resolve(__dirname, "../renderer");
    protocol.handle("multiplayer", (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "desktop" || request.method !== "GET")
        return new Response("Forbidden", { status: 403 });
      let file: string;
      try {
        file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
      } catch {
        return new Response("Invalid path", { status: 400 });
      }
      if (!file.startsWith(rendererRoot + sep))
        return new Response("Forbidden", { status: 403 });
      return net.fetch(pathToFileURL(file).href);
    });
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    // Renderer stays offline. Authenticated Supabase transport is owned by the main process.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const local =
        url.protocol === "multiplayer:" && url.hostname === "desktop";
      const development =
        devUrl &&
        ["http:", "ws:"].includes(url.protocol) &&
        url.host === new URL(devUrl).host;
      // net.fetch is used only by the private asset protocol handler for the packaged renderer.
      const asset =
        url.protocol === "file:" && details.webContentsId === undefined;
      callback({
        cancel: !(
          local ||
          development ||
          asset ||
          url.protocol === "devtools:"
        ),
      });
    });
    supervisor = new SupervisorClient(
      join(__dirname, "supervisor.cjs"),
      app.getPath("userData"),
      (snapshot) => coordinator?.acceptLocal(snapshot),
      (health) => window?.webContents.send(HEALTH_CHANNEL, health),
      (value) => {
        const url = new URL(value);
        if (testing && process.env.MP_TEST_CODEX_FIXTURE) return;
        if (
          url.protocol === "https:" &&
          ["auth.openai.com", "chatgpt.com"].includes(url.hostname) &&
          !url.username &&
          !url.password
        )
          void shell.openExternal(url.href);
      },
      testing ? process.env.MP_TEST_CODEX_FIXTURE : undefined,
    );
    collaboration = new CollaborationClient(
      testing && process.env.MP_TEST_SUPABASE_URL
        ? {
            url: process.env.MP_TEST_SUPABASE_URL,
            publishableKey: "sb_publishable_local_test",
          }
        : supabaseConfig,
      new AuthStorage(app.getPath("userData"), safeStorage),
      (url) => shell.openExternal(url),
      () => coordinator?.changed(),
      testing,
    );
    coordinator = new DesktopCoordinator(
      supervisor,
      collaboration,
      (snapshot) => window?.webContents.send(SNAPSHOT_CHANNEL, snapshot),
      async () => {
        if (!window) return null;
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          title: "Select a local Git repository",
          properties: ["openDirectory"],
          buttonLabel: "Use repository",
        });
        return canceled || !filePaths[0]
          ? null
          : inspectWorkspace(filePaths[0]);
      },
    );
    ipcMain.handle(
      COMMAND_CHANNEL,
      async (event, input: unknown): Promise<Result> => {
        if (
          !window ||
          event.sender.id !== window.webContents.id ||
          event.senderFrame !== window.webContents.mainFrame ||
          !isTrustedDocument(event.senderFrame.url, documentUrl)
        )
          return { ok: false, error: "Untrusted desktop IPC sender." };
        const parsed = commandSchema.safeParse(input);
        if (!parsed.success)
          return { ok: false, error: "Invalid desktop request." };
        return coordinator.dispatch(parsed.data);
      },
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "File", submenu: [{ role: "quit" }] },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
            ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
          ],
        },
      ]),
    );
    createWindow();
    app.on("activate", () => {
      if (!window) createWindow();
    });
  });
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  collaboration?.close();
  supervisor?.stop();
});
