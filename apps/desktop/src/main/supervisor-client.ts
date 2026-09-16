import { utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import type {
  Health,
  Result,
  Snapshot,
  SupervisorMessage,
  SupervisorRequest,
} from "../shared/contracts";

export class SupervisorClient {
  private child: UtilityProcess;
  private pending = new Map<
    string,
    { resolve: (result: Result) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private ready: Promise<void>;
  private heartbeatAt = Date.now();
  private monitor: ReturnType<typeof setInterval>;
  private alive = true;
  private health: Health = {
    status: "connecting",
    message: "Connecting to local supervisor",
  };
  private lastSnapshot?: Snapshot;

  constructor(
    entry: string,
    directory: string,
    private onSnapshot: (snapshot: Snapshot) => void,
    private onHealth: (health: Health) => void,
    private openProviderLogin?: (url: string) => void,
    codexFixture?: string,
  ) {
    // Credentials and provider keys from the launching terminal are not inherited by the mock supervisor.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|PATHEXT)$/i.test(
          key,
        ),
      ),
    );
    this.child = utilityProcess.fork(entry, [directory, codexFixture ?? ""], {
      serviceName: "Multiplayer AI Supervisor",
      stdio: "pipe",
      env,
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error("Local supervisor did not start within 15 seconds."),
          ),
        15_000,
      );
      this.child.on("message", (message: SupervisorMessage) => {
        this.heartbeatAt = Date.now();
        if (message.type === "open-provider-login")
          this.openProviderLogin?.(message.url);
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve();
        }
        if (message.type === "ready" || message.type === "snapshot") {
          this.lastSnapshot = message.snapshot;
          this.onSnapshot(message.snapshot);
        }
        if (message.type === "response") {
          const request = this.pending.get(message.id);
          if (request) {
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            request.resolve(message.result);
          }
        }
        this.setHealth({
          status: "live",
          message: "Local supervisor connected",
        });
      });
      this.child.once("exit", () => {
        clearTimeout(timer);
        this.alive = false;
        reject(
          new Error("Local supervisor stopped. Restart the app to recover."),
        );
        this.fail(
          "Local supervisor stopped. Restart the app to recover recorded work.",
        );
      });
    });
    // Startup can fail before the renderer requests state.
    void this.ready.catch(() =>
      this.fail("Local supervisor could not start. Restart the app to retry."),
    );
    this.child.stderr?.on("data", () => {
      /* Never forward raw local paths or logs into room state. */
    });
    this.child.stdout?.resume();
    this.monitor = setInterval(() => {
      if (Date.now() - this.heartbeatAt > 7_000)
        this.fail(
          "Supervisor updates are stale. Dispatch is paused; restart the app if this persists.",
        );
    }, 2_000);
  }

  private setHealth(health: Health) {
    if (
      this.health.status !== health.status ||
      this.health.message !== health.message
    ) {
      this.health = health;
      this.onHealth(health);
    }
  }

  private fail(message: string) {
    this.setHealth({ status: "stale", message });
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error: message });
    }
    this.pending.clear();
  }

  getHealth() {
    return this.health;
  }
  getLastSnapshot() {
    return this.lastSnapshot;
  }

  async request(command: SupervisorRequest["command"]): Promise<Result> {
    try {
      await this.ready;
    } catch {
      return { ok: false, error: this.health.message };
    }
    if (!this.alive || this.health.status !== "live")
      return { ok: false, error: this.health.message };
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          resolve({
            ok: false,
            error:
              "The local operation timed out. Refresh state before retrying a mutation.",
          });
        },
        command.type.startsWith("provider.") ? 90_000 : 20_000,
      );
      this.pending.set(id, { resolve, timer });
      this.child.postMessage({ id, command } satisfies SupervisorRequest);
    });
  }

  stop() {
    clearInterval(this.monitor);
    this.fail("Desktop is closing.");
    this.child.kill();
  }
}
