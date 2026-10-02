import {
  HARNESS_LABELS,
  newerVersion,
  type HarnessId,
  type HarnessModel,
  type HarnessState,
} from "../../shared/tabs";
import { ProgramError, type ProgramManager } from "../programs/manager";
import {
  HarnessError,
  type HarnessAdapter,
  type LaunchContext,
} from "./contract";
import { launchEnvironment } from "./environment";
import type { ProgramRelease } from "../programs/release";
import type { PlatformKey } from "../programs/types";

interface Settings {
  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
}

const executableKey = (harness: HarnessId) => `harness.${harness}.executable`;
const noticeKey = (harness: HarnessId) =>
  `harness.${harness}.noticeAcknowledged`;
const defaultKey = (harness: HarnessId) => `harness.${harness}.default`;
const releaseKey = (harness: HarnessId) => `harness.${harness}.release`;

/** The host's own default model, and the effort each model starts at. */
interface DefaultChoice {
  model: string;
  efforts: Record<string, string>;
}

/** The harness's models with the host's saved defaults laid over the harness's own. */
function withChoice(models: HarnessModel[], choice?: DefaultChoice) {
  if (!choice) return models;
  const chosen = models.some((model) => model.id === choice.model);
  return models.map((model) => {
    const effort = choice.efforts[model.id];
    return {
      ...model,
      isDefault: chosen ? model.id === choice.model : model.isDefault,
      defaultEffort:
        effort && model.efforts.includes(effort) ? effort : model.defaultEffort,
    };
  });
}

/**
 * Per-harness program, sign-in, and model state. Program acquisition, handshakes, and inspection
 * run here; adapters only speak their protocol.
 */
export class HarnessRegistry {
  private states = new Map<HarnessId, HarnessState>();
  private adapters = new Map<HarnessId, HarnessAdapter>();
  private refreshing = new Map<HarnessId, Promise<void>>();
  // Models as the harness reported them, before the host's saved defaults.
  private reported = new Map<HarnessId, HarnessModel[]>();
  private latestCheckedAt = new Map<HarnessId, number>();
  // Bumped when the executable changes so work started for the old one stops writing state.
  private generations = new Map<HarnessId, number>();
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
      // Reads the newest published program version; left out, no update check runs.
      latest?: (harness: HarnessId) => Promise<string | null>;
      // Finds a published version's download and digest; left out, updates are unavailable.
      release?: (
        harness: HarnessId,
        version: string,
        platform: PlatformKey,
      ) => Promise<ProgramRelease>;
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
      // An earlier update stays in use until the app ships that version or a newer one.
      const release = options.settings.getSetting<ProgramRelease>(
        releaseKey(adapter.id),
      );
      if (release) {
        if (newerVersion(release.version, options.programs.bundled(adapter.id)))
          options.programs.use(adapter.id, release);
        else options.settings.setSetting(releaseKey(adapter.id), undefined);
      }
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
        ...(options.programs.release(adapter.id)
          ? { bundledVersion: options.programs.bundled(adapter.id) }
          : {}),
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

  /** An update function that ignores writes once the harness's executable has changed. */
  private updater(harness: HarnessId) {
    const generation = this.generations.get(harness) ?? 0;
    return (change: (state: HarnessState) => void) => {
      if ((this.generations.get(harness) ?? 0) === generation)
        this.update(harness, change);
    };
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
    const update = this.updater(harness);
    const env = await this.environment;
    try {
      if (!custom)
        update((state) => {
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
        update((state) => {
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
      } else if (program.source === "managed") {
        // Keeps the executable digest an update learned when it was unpacked.
        const release = this.options.programs.release(harness);
        if (release?.asset.binary)
          this.options.settings.setSetting(releaseKey(harness), release);
        update((state) => {
          state.program = {
            state: "ready",
            version: program.version,
            pinned: state.program.pinned,
          };
        });
      }
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
      update((state) => {
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
    const update = this.updater(harness);
    this.checkLatest(harness);
    const job: Promise<void> = (async () => {
      const context = await this.context(harness);
      // A known sign-in state stays in place while it is re-read, so ready tabs stay usable.
      update((state) => {
        if (state.auth.state === "unknown") state.auth = { state: "checking" };
      });
      try {
        const inspection = await this.adapter(harness).inspect(context);
        update((state) => {
          state.auth = inspection.auth;
          this.reported.set(harness, inspection.models);
          state.models = withChoice(
            inspection.models,
            this.options.settings.getSetting<DefaultChoice>(
              defaultKey(harness),
            ),
          );
          state.limits = inspection.limits;
          state.modelsRefreshedAt = new Date().toISOString();
        });
      } catch (error) {
        update((state) => {
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
      .finally(() => {
        if (this.refreshing.get(harness) === job)
          this.refreshing.delete(harness);
      });
    this.refreshing.set(harness, job);
    return job;
  }

  /** Looks up the newest published version in the background, at most every six hours. */
  private checkLatest(harness: HarnessId) {
    const latest = this.options.latest;
    const checked = this.latestCheckedAt.get(harness) ?? 0;
    if (!latest || Date.now() - checked < 6 * 60 * 60_000) return;
    this.latestCheckedAt.set(harness, Date.now());
    void latest(harness)
      .catch(() => null)
      .then((version) => {
        if (!version) return this.latestCheckedAt.delete(harness);
        this.update(harness, (state) => {
          state.latestVersion = version;
        });
      });
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
    this.generations.set(harness, (this.generations.get(harness) ?? 0) + 1);
    this.refreshing.delete(harness);
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
    this.reported.delete(harness);
  }

  /** Moves the managed program to the newest published version and re-reads the harness. */
  async updateProgram(harness: HarnessId) {
    const label = HARNESS_LABELS[harness];
    const version = this.state(harness).latestVersion;
    const platform = this.options.programs.platform();
    if (this.customPath(harness))
      throw new Error(
        `${label} runs your own executable. Update that program yourself.`,
      );
    if (!this.options.release || !platform)
      throw new Error(`${label} cannot be updated from this build.`);
    if (
      !version ||
      !newerVersion(version, this.options.programs.pinned(harness))
    )
      throw new Error(`${label} is already on the newest version.`);
    const release = await this.options.release(harness, version, platform);
    this.switchProgram(harness, release);
  }

  /** Returns the managed program to the version this app ships with. */
  revertUpdate(harness: HarnessId) {
    if (this.options.programs.release(harness))
      this.switchProgram(harness, null);
  }

  private switchProgram(harness: HarnessId, release: ProgramRelease | null) {
    this.options.programs.use(harness, release);
    this.options.settings.setSetting(releaseKey(harness), release ?? undefined);
    this.generations.set(harness, (this.generations.get(harness) ?? 0) + 1);
    this.refreshing.delete(harness);
    this.handshaken.delete(harness);
    this.reported.delete(harness);
    this.update(harness, (state) => {
      state.program = {
        state: "unknown",
        version: null,
        pinned: this.options.programs.pinned(harness),
      };
      if (release)
        state.bundledVersion = this.options.programs.bundled(harness);
      else delete state.bundledVersion;
    });
    void this.refresh(harness).catch(() => {
      /* The failure is recorded in the harness state. */
    });
  }

  /** Saves the model new tabs start on and the effort that model starts at. */
  setDefault(harness: HarnessId, model: string, effort?: string) {
    const reported = this.reported.get(harness) ?? [];
    const target = reported.find((item) => item.id === model);
    if (!target)
      throw new Error(
        `${model} is not offered by ${HARNESS_LABELS[harness]} right now.`,
      );
    if (effort && !target.efforts.includes(effort))
      throw new Error(`${target.name} does not support ${effort} effort.`);
    const previous = this.options.settings.getSetting<DefaultChoice>(
      defaultKey(harness),
    );
    const choice: DefaultChoice = {
      model,
      efforts: { ...previous?.efforts, ...(effort ? { [model]: effort } : {}) },
    };
    this.options.settings.setSetting(defaultKey(harness), choice);
    this.update(harness, (state) => {
      state.models = withChoice(reported, choice);
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
