import {
  HARNESS_LABELS,
  type HarnessId,
  type HarnessState,
} from "../../shared/tabs";
import { ProgramError, type ProgramManager } from "../programs/manager";
import {
  HarnessError,
  type HarnessAdapter,
  type LaunchContext,
} from "./contract";
import { launchEnvironment } from "./environment";

interface Settings {
  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
}

const executableKey = (harness: HarnessId) => `harness.${harness}.executable`;
const noticeKey = (harness: HarnessId) =>
  `harness.${harness}.noticeAcknowledged`;

/**
 * Per-harness program, sign-in, and model state. Program acquisition, handshakes, and inspection
 * run here; adapters only speak their protocol.
 */
export class HarnessRegistry {
  private states = new Map<HarnessId, HarnessState>();
  private adapters = new Map<HarnessId, HarnessAdapter>();
  private refreshing = new Map<HarnessId, Promise<void>>();
  // Custom executables that passed the handshake, so turns do not repeat it.
  private handshaken = new Map<HarnessId, string>();
  private environment: Promise<Record<string, string>>;
  private provideEnvironment!: (env: Record<string, string>) => void;
  private fallback?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private options: {
      adapters: HarnessAdapter[];
      programs: ProgramManager;
      settings: Settings;
      changed: () => void;
      openLogin?: (harness: HarnessId, url: string) => void;
      // Main sends the login-shell environment; until then (or after the timeout) the
      // supervisor's own environment is used.
      environmentTimeoutMs?: number;
    },
  ) {
    this.environment = new Promise((resolve) => {
      this.provideEnvironment = resolve;
    });
    this.fallback = setTimeout(
      () => this.provideEnvironment(launchEnvironment(process.env)),
      options.environmentTimeoutMs ?? 15_000,
    );
    this.fallback.unref?.();
    for (const adapter of options.adapters) {
      this.adapters.set(adapter.id, adapter);
      const customPath = options.settings.getSetting<string>(
        executableKey(adapter.id),
      );
      this.states.set(adapter.id, {
        id: adapter.id,
        label: HARNESS_LABELS[adapter.id],
        program: {
          state: customPath ? "custom" : "unknown",
          version: null,
          pinned: options.programs.pinned(adapter.id),
          ...(customPath ? { customPath } : {}),
        },
        auth: { state: "unknown" },
        signIn: adapter.signIn,
        reportsAgents: adapter.reportsAgents,
        models: [],
        modelsRefreshedAt: null,
        limits: [],
        noticePending:
          adapter.signIn === "guidance" &&
          !options.settings.getSetting<boolean>(noticeKey(adapter.id)),
      });
      adapter.onChange?.(() => void this.refresh(adapter.id));
    }
    options.programs.on("progress", ({ harness, received, total }) =>
      this.update(harness, (state) => {
        state.program.state = "downloading";
        state.program.progress = total ? Math.min(1, received / total) : 0;
      }),
    );
    // Report whether managed programs are already stored, without downloading.
    for (const harness of this.states.keys())
      if (!this.customPath(harness))
        void options.programs.installed(harness).then((installed) =>
          this.update(harness, (state) => {
            if (state.program.state === "unknown")
              state.program.state = installed ? "ready" : "missing";
            if (installed) state.program.version = state.program.pinned;
          }),
        );
  }

  setEnvironment(env: Record<string, string>) {
    clearTimeout(this.fallback);
    this.provideEnvironment(launchEnvironment(env));
  }

  snapshot(): HarnessState[] {
    return [...this.states.values()].map((state) => structuredClone(state));
  }

  state(harness: HarnessId): HarnessState {
    const state = this.states.get(harness);
    if (!state) throw new Error("That harness is not available in this build.");
    return state;
  }

  adapter(harness: HarnessId): HarnessAdapter {
    const adapter = this.adapters.get(harness);
    if (!adapter)
      throw new Error("That harness is not available in this build.");
    return adapter;
  }

  ready(harness: HarnessId) {
    const state = this.state(harness);
    return (
      ["ready", "custom"].includes(state.program.state) &&
      state.auth.state === "signed_in"
    );
  }

  private update(harness: HarnessId, change: (state: HarnessState) => void) {
    if (this.closed) return;
    change(this.state(harness));
    this.options.changed();
  }

  private customPath(harness: HarnessId) {
    return this.options.settings.getSetting<string>(executableKey(harness));
  }

  /** Resolves the program (downloading or handshaking as needed) and the launch environment. */
  async context(harness: HarnessId): Promise<LaunchContext> {
    const adapter = this.adapter(harness);
    const custom = this.customPath(harness);
    const env = await this.environment;
    try {
      if (!custom)
        this.update(harness, (state) => {
          if (state.program.state !== "ready") {
            state.program.state = "downloading";
            state.program.progress = 0;
            delete state.program.message;
          }
        });
      const program = await this.options.programs.resolve(harness, custom);
      const context = { executable: program.path, env };
      if (
        program.source === "custom" &&
        this.handshaken.get(harness) !== program.path
      ) {
        let version: string | null;
        try {
          ({ version } = await adapter.handshake(context));
        } catch (error) {
          throw new ProgramError(
            "custom_invalid",
            `The custom executable did not respond like ${HARNESS_LABELS[harness]}. ${error instanceof Error ? error.message : ""}`.trim(),
          );
        }
        this.update(harness, (state) => {
          state.program = {
            state: "custom",
            version,
            pinned: state.program.pinned,
            customPath: program.path,
            ...(version !== state.program.pinned
              ? {
                  warning: `This executable reports version ${version ?? "unknown"}; the app is tested with ${state.program.pinned}.`,
                }
              : {}),
          };
        });
        this.handshaken.set(harness, program.path);
      } else if (program.source === "managed")
        this.update(harness, (state) => {
          state.program = {
            state: "ready",
            version: program.version,
            pinned: state.program.pinned,
          };
        });
      return context;
    } catch (error) {
      this.handshaken.delete(harness);
      const failure =
        error instanceof ProgramError
          ? error
          : new ProgramError(
              "network",
              error instanceof Error ? error.message : "The program failed.",
            );
      this.update(harness, (state) => {
        state.program = {
          state:
            failure.code === "custom_invalid"
              ? "custom_invalid"
              : failure.code === "unsupported_platform"
                ? "unsupported"
                : "failed",
          version: null,
          pinned: state.program.pinned,
          ...(custom ? { customPath: custom } : {}),
          message: failure.message,
        };
      });
      throw new HarnessError("unavailable", failure.message);
    }
  }

  /** Acquires the program if needed and re-reads sign-in and models. */
  refresh(harness: HarnessId): Promise<void> {
    const running = this.refreshing.get(harness);
    if (running) return running;
    const job = (async () => {
      const context = await this.context(harness);
      // A known sign-in state stays in place while it is re-read, so ready tabs stay usable.
      this.update(harness, (state) => {
        if (state.auth.state === "unknown") state.auth = { state: "checking" };
      });
      try {
        const inspection = await this.adapter(harness).inspect(context);
        this.update(harness, (state) => {
          state.auth = inspection.auth;
          state.models = inspection.models;
          state.limits = inspection.limits;
          state.modelsRefreshedAt = new Date().toISOString();
        });
      } catch (error) {
        this.update(harness, (state) => {
          state.auth = {
            state: "unknown",
            message:
              error instanceof Error
                ? error.message
                : "The harness could not report its sign-in state.",
          };
        });
      }
    })()
      .catch(() => {
        /* Program failures are recorded in the harness state. */
      })
      .finally(() => this.refreshing.delete(harness));
    this.refreshing.set(harness, job);
    return job;
  }

  async signIn(harness: HarnessId) {
    const adapter = this.adapter(harness);
    if (adapter.signIn !== "in_app" || !adapter.startSignIn)
      throw new Error(
        `${HARNESS_LABELS[harness]} uses the sign-in already on this computer. See Harness settings for guidance.`,
      );
    const url = await adapter.startSignIn(await this.context(harness));
    if (!url) return this.refresh(harness);
    this.update(harness, (state) => {
      state.auth = {
        state: "signing_in",
        message: "Complete the sign-in in your browser.",
      };
    });
    this.options.openLogin?.(harness, url);
  }

  setExecutable(harness: HarnessId, path: string | null) {
    this.handshaken.delete(harness);
    this.options.settings.setSetting(executableKey(harness), path ?? undefined);
    this.update(harness, (state) => {
      state.program = {
        state: path ? "custom" : "unknown",
        version: null,
        pinned: state.program.pinned,
        ...(path ? { customPath: path } : {}),
      };
      state.auth = { state: "unknown" };
      state.models = [];
    });
  }

  acknowledgeNotice(harness: HarnessId) {
    this.options.settings.setSetting(noticeKey(harness), true);
    this.update(harness, (state) => {
      state.noticePending = false;
    });
  }

  markSignedOut(harness: HarnessId, message: string) {
    this.update(harness, (state) => {
      state.auth = { state: "signed_out", message };
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.fallback);
    for (const adapter of this.adapters.values()) adapter.close();
  }
}
