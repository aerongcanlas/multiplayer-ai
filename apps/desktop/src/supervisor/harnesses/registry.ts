import {
  HARNESS_LABELS,
  HARNESS_NOTICES,
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
import {
  assertHome,
  hostPaths,
  withHome,
  type Accounts,
  type HostPaths,
} from "./accounts";
import type { LatestRelease } from "../programs/latest";
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
const hiddenKey = (harness: HarnessId) => `harness.${harness}.hiddenModels`;
const styleKey = (harness: HarnessId) => `harness.${harness}.outputStyle`;
const NEW_TAB_KEY = "harness.newTab";

/** The host's own default model, and the effort each model starts at. */
interface DefaultChoice {
  model: string;
  efforts: Record<string, string>;
}

/** The harness's models with the host's saved defaults and hidden models laid over them. */
function withChoice(
  models: HarnessModel[],
  choice?: DefaultChoice,
  hidden: string[] = [],
) {
  const chosen = models.some((model) => model.id === choice?.model);
  return models.map((model) => {
    const effort = choice?.efforts[model.id];
    const isDefault = chosen ? model.id === choice?.model : model.isDefault;
    return {
      ...model,
      isDefault,
      defaultEffort:
        effort && model.efforts.includes(effort) ? effort : model.defaultEffort,
      // The model new tabs start on always stays in the picker.
      ...(hidden.includes(model.id) && !isDefault ? { hidden: true } : {}),
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
  // The launch environment without host credentials, and where the host keeps its own setup.
  private environment: Promise<{
    env: Record<string, string>;
    host: HostPaths;
  }>;
  private provideEnvironment!: (value: {
    env: Record<string, string>;
    host: HostPaths;
  }) => void;
  private fallback?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private options: {
      adapters: HarnessAdapter[];
      programs: ProgramManager;
      // App-owned harness homes; every launch, check, and sign-in runs in one (R15).
      accounts: Accounts;
      settings: Settings;
      changed: () => void;
      openLogin?: (harness: HarnessId, url: string) => void;
      // Reads the newest published program version; left out, no update check runs.
      latest?: (harness: HarnessId) => Promise<LatestRelease | null>;
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
      () => this.provideEnvironment(this.split(process.env)),
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
        ...(options.settings.getSetting<string>(styleKey(adapter.id))
          ? {
              outputStyle: options.settings.getSetting<string>(
                styleKey(adapter.id),
              ),
            }
          : {}),
        modelsRefreshedAt: null,
        limits: [],
        noticePending:
          HARNESS_NOTICES[adapter.id] !== null &&
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
    this.provideEnvironment(this.split(env));
  }

  private split(env: Record<string, string | undefined>) {
    return { env: launchEnvironment(env), host: hostPaths(env) };
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
    const { env: hostEnv, host } = await this.environment;
    // No launch ever falls back to the host's own harness folders (R15).
    let home: string;
    try {
      home = await this.options.accounts.prepare(
        harness,
        adapter.account,
        host,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The app could not prepare its harness folder.";
      update((state) => {
        state.auth = { state: "unknown", message };
      });
      throw new HarnessError("unavailable", message);
    }
    const env = withHome(hostEnv, adapter.account.variable, home);
    assertHome({ env, home }, adapter.account.variable, this.options.accounts);
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
      const outputStyle = this.options.settings.getSetting<string>(
        styleKey(harness),
      );
      const defaultModel = this.options.settings.getSetting<DefaultChoice>(
        defaultKey(harness),
      )?.model;
      const context: LaunchContext = {
        executable: program.path,
        env,
        home,
        hostPaths: host,
        ...(outputStyle ? { outputStyle } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      };
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
            ...(version !== this.options.programs.bundled(harness)
              ? {
                  warning: `This executable reports version ${version ?? "unknown"}; the app is tested with ${this.options.programs.bundled(harness)}.`,
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
          state.models = this.shown(harness, inspection.models);
          if (inspection.outputStyles)
            state.outputStyles = inspection.outputStyles;
          if (inspection.localServers)
            state.localServers = inspection.localServers;
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
      .then((latest) => {
        if (!latest) return this.latestCheckedAt.delete(harness);
        this.update(harness, (state) => {
          state.latestVersion = latest.version;
          if (latest.later) state.laterVersion = latest.later;
          else delete state.laterVersion;
        });
      });
  }

  async signIn(harness: HarnessId) {
    const adapter = this.adapter(harness);
    if (adapter.signIn !== "in_app" || !adapter.startSignIn)
      throw new Error(
        `${HARNESS_LABELS[harness]} uses the sign-in already on this computer. See Settings for guidance.`,
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
      state.auth = { state: "unknown" };
      state.models = [];
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
      state.models = this.shown(harness, reported);
    });
  }

  private shown(harness: HarnessId, models: HarnessModel[]) {
    const { settings } = this.options;
    return withChoice(
      models,
      settings.getSetting<DefaultChoice>(defaultKey(harness)),
      settings.getSetting<string[]>(hiddenKey(harness)),
    );
  }

  /** The harness new tabs open with: the host's choice, else Claude Code, else the first. */
  newTabHarness(): HarnessId {
    const saved = this.options.settings.getSetting<HarnessId>(NEW_TAB_KEY);
    for (const id of [saved, "claude" as const])
      if (id && this.adapters.has(id)) return id;
    return [...this.adapters.keys()][0]!;
  }

  setNewTabHarness(harness: HarnessId) {
    this.adapter(harness);
    this.options.settings.setSetting(NEW_TAB_KEY, harness);
    this.options.changed();
  }

  /** Shows or hides a model in the tab model picker. */
  setModelHidden(harness: HarnessId, model: string, hidden: boolean) {
    const reported = this.reported.get(harness) ?? [];
    const target = this.state(harness).models.find((item) => item.id === model);
    if (!target)
      throw new Error(
        `${model} is not offered by ${HARNESS_LABELS[harness]} right now.`,
      );
    if (hidden && target.isDefault)
      throw new Error(
        `${target.name} is the default for new tabs. Choose another default first.`,
      );
    const saved = new Set(
      this.options.settings.getSetting<string[]>(hiddenKey(harness)),
    );
    if (hidden) saved.add(model);
    else saved.delete(model);
    this.options.settings.setSetting(hiddenKey(harness), [...saved]);
    this.update(harness, (state) => {
      state.models = this.shown(harness, reported);
    });
  }

  /** Saves the output style new sessions start with; null returns to the harness's own. */
  setOutputStyle(harness: HarnessId, style: string | null) {
    const offered = this.state(harness).outputStyles;
    if (!offered)
      throw new Error(`${HARNESS_LABELS[harness]} has no output styles.`);
    if (style && !offered.includes(style))
      throw new Error(
        `${style} is not an output style ${HARNESS_LABELS[harness]} offers right now.`,
      );
    this.options.settings.setSetting(styleKey(harness), style ?? undefined);
    this.update(harness, (state) => {
      if (style) state.outputStyle = style;
      else delete state.outputStyle;
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
