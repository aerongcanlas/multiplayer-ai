import { homedir } from "node:os";
import {
  RequestError,
  type AvailableCommand,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { HarnessModel, SlashCommand } from "../../../shared/tabs";
import {
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  type Inspection,
  type LaunchContext,
  type OpenRequest,
} from "../contract";
import { slashCommands } from "../commands";
import { object, string } from "../json";
import { buildConfig, HostConfigs, hostedLogin } from "./config";
import { discover, type Discovery } from "./discovery";
import {
  direct,
  OpenCodeProcess,
  runCommand,
  type Launcher,
  type ProcessOwner,
} from "./process";
import { choose, OpenCodeSession } from "./session";
import { loginCommand } from "./account";

const IDLE_MS = 10 * 60_000;
const EFFORT = /^[a-z][a-z0-9_-]{0,23}$/;
const LOCAL = new Set(["ollama", "lmstudio"]);
const PROVIDER_NAMES: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
};
export const NO_MODELS =
  "No models available. Start Ollama or LM Studio with a tool-capable model and at least 32k of context (OLLAMA_CONTEXT_LENGTH for Ollama), run `ollama launch opencode`, or sign in a hosted provider with the command shown in Settings, then refresh.";

/** Parses `opencode models --verbose`: an id line, then that model's JSON. */
export function parseModels(output: string): HarnessModel[] {
  const models: HarnessModel[] = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const id = lines[index]!.trim();
    if (!/^[^\s/{}]+\/\S+$/.test(id)) continue;
    let details: Record<string, unknown> = {};
    if (lines[index + 1]?.startsWith("{")) {
      const end = lines.findIndex(
        (line, at) => at > index && line.startsWith("}"),
      );
      if (end > index) {
        try {
          details = object(
            JSON.parse(lines.slice(index + 1, end + 1).join("\n")),
          );
        } catch {
          details = {};
        }
        index = end;
      }
    }
    models.push({
      id,
      name: string(details.name) || id,
      // Variant names the loadout cannot carry are left out.
      efforts: Object.keys(object(details.variants)).filter((name) =>
        EFFORT.test(name),
      ),
      defaultEffort: null,
      isDefault: false,
    });
  }
  return models;
}

export interface OpenCodeOptions {
  launcher?: Launcher;
  idleMs?: number;
  // How long Stop waits for OpenCode to report the turn cancelled before ending it anyway.
  stopTimeoutMs?: number;
  // Tests replace local model discovery.
  discover?: (env: Record<string, string>) => Promise<Discovery>;
}

/** OpenCode tabs over ACP, with local models from Ollama and LM Studio (KTD1–KTD12). */
export class OpenCodeAdapter implements HarnessAdapter, ProcessOwner {
  readonly id = "opencode" as const;
  // Hosted providers sign in with a copy-ready terminal command; local models need none. OpenCode
  // keeps using the host's own data folder: isolating it would reach tool shells (see docs).
  readonly signIn = "command" as const;
  // OpenCode's ACP does not report sub-agents, and app sessions deny its task tool.
  readonly reportsAgents = false;
  readonly idleMs: number;
  readonly stopTimeoutMs: number;
  closed = false;
  private processes = new Map<string, OpenCodeProcess>();
  private hostConfigs: HostConfigs;
  private discovery?: Promise<Discovery>;
  private commandsByFolder = new Map<string, SlashCommand[]>();

  constructor(private options: OpenCodeOptions = {}) {
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    this.hostConfigs = new HostConfigs(this.launcher);
  }

  private get launcher() {
    return this.options.launcher ?? direct;
  }

  private discovered(env: Record<string, string>, fresh = false) {
    if (fresh || !this.discovery) {
      this.discovery = (this.options.discover ?? discover)(env);
      this.discovery.catch(() => (this.discovery = undefined));
    }
    return this.discovery;
  }

  /** The injected config for a folder: host config there, local models, and the saved default. */
  private async config(context: LaunchContext, cwd: string) {
    const [host, found, login] = await Promise.all([
      this.hostConfigs.get(context, cwd),
      this.discovered(context.env),
      hostedLogin(context.env),
    ]);
    const built = buildConfig({
      host,
      providers: found.providers,
      ...(context.defaultModel ? { defaultModel: context.defaultModel } : {}),
      hostedLogin: login,
      env: context.env,
    });
    return { ...built, login, found };
  }

  /** The process for an executable and config, started on first use. The caller releases it. */
  private async process(
    context: LaunchContext,
    config: Awaited<ReturnType<OpenCodeAdapter["config"]>>,
  ) {
    if (this.closed)
      throw new HarnessError("failed", "The app is shutting down.");
    const key = `${context.executable}\n${config.hash}`;
    let process = this.processes.get(key);
    if (!process?.alive || process.draining) {
      process = new OpenCodeProcess(
        key,
        context,
        config.env,
        this.launcher,
        this,
      );
      this.processes.set(key, process);
    }
    process.hold();
    try {
      await process.ready;
    } catch (error) {
      process.release();
      process.close();
      throw new HarnessError(
        "unavailable",
        `OpenCode could not start. ${error instanceof Error ? error.message : ""}`.trim(),
      );
    }
    return process;
  }

  // ProcessOwner: events and permission requests are routed by OpenCode's session ID.
  update(process: OpenCodeProcess, params: SessionNotification) {
    (
      process.sessions.get(params.sessionId) as OpenCodeSession | undefined
    )?.update(params);
  }

  permission(process: OpenCodeProcess, params: RequestPermissionRequest) {
    const session = process.sessions.get(params.sessionId) as
      OpenCodeSession | undefined;
    // A request no open tab owns is never allowed.
    if (!session) return Promise.resolve(choose(params.options, "reject_once"));
    return session.permission(params);
  }

  exited(process: OpenCodeProcess, message: string) {
    this.forget(process);
    for (const session of process.sessions.values())
      (session as OpenCodeSession).crashed(message);
  }

  forget(process: OpenCodeProcess) {
    if (this.processes.get(process.key) === process)
      this.processes.delete(process.key);
  }

  /** A session left its process; a process that no tab still needs drains. */
  left(process: OpenCodeProcess) {
    if (!process.sessions.size && this.processes.get(process.key) !== process)
      process.retire();
    else process.touch();
  }

  /**
   * Moves a session to the process for the config its folder needs now (KTD3). The old process
   * takes no new turns from it and closes once nothing runs there.
   */
  async place(session: OpenCodeSession, request: OpenRequest) {
    const config = await this.config(request, request.cwd);
    const key = `${request.executable}\n${config.hash}`;
    const current = session.process;
    if (current.alive && !current.draining && current.key === key) return;
    const process = await this.process(request, config);
    try {
      await this.resume(process, session.sessionId, request.cwd);
      current.sessions.delete(session.sessionId);
      process.sessions.set(session.sessionId, session);
      session.process = process;
      // Other tabs move at their next turn; running turns finish where they are.
      if (current.alive) current.retire();
    } finally {
      process.release();
    }
  }

  private async resume(
    process: OpenCodeProcess,
    sessionId: string,
    cwd: string,
  ) {
    try {
      return await process.call(
        (connection) =>
          connection.resumeSession({ sessionId, cwd, mcpServers: [] }),
        60_000,
      );
    } catch (error) {
      if (error instanceof RequestError)
        throw new HarnessError(
          "resume_failed",
          `OpenCode could not resume this tab's session: ${error.message}`,
        );
      throw error;
    }
  }

  async handshake(context: LaunchContext) {
    const owner: ProcessOwner = {
      idleMs: this.idleMs,
      closed: false,
      update: () => {},
      permission: async (_process, params) =>
        choose(params.options, "reject_once"),
      exited: () => {},
      forget: () => {},
    };
    const process = new OpenCodeProcess(
      "handshake",
      context,
      {},
      this.launcher,
      owner,
    );
    try {
      await Promise.race([
        process.ready,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("OpenCode did not answer ACP initialize.")),
            10_000,
          ).unref?.(),
        ),
      ]);
      return { version: process.version };
    } finally {
      process.close();
    }
  }

  async inspect(context: LaunchContext): Promise<Inspection> {
    // A refresh re-reads the host's config and the local servers.
    this.hostConfigs.clear();
    await this.discovered(context.env, true);
    const config = await this.config(context, homedir());
    const output = await runCommand(
      context,
      this.launcher,
      ["models", "--verbose"],
      { cwd: homedir(), config: config.env, timeoutMs: 60_000 },
    );
    const defaultModel = string(config.content.model);
    const models = parseModels(output)
      // OpenCode's anonymous free models never count without its login (KTD7, KTD8).
      .filter((model) => config.login || !model.id.startsWith("opencode/"))
      .map((model) => ({ ...model, isDefault: model.id === defaultModel }));
    if (models.length && !models.some((model) => model.isDefault))
      models[0]!.isDefault = true;
    const providers = [
      ...new Set(models.map((model) => model.id.split("/")[0]!)),
    ];
    const command = loginCommand(context.executable);
    return {
      auth: models.length
        ? {
            state: "signed_in",
            account: providers.every((id) => LOCAL.has(id))
              ? "Local models"
              : providers.map((id) => PROVIDER_NAMES[id] ?? id).join(", "),
            command,
          }
        : { state: "signed_out", message: NO_MODELS, command },
      models,
      limits: [],
      localServers: config.found.servers,
    };
  }

  async open(request: OpenRequest): Promise<HarnessSession> {
    const config = await this.config(request, request.cwd);
    const process = await this.process(request, config);
    try {
      let sessionId = request.sessionId;
      let options;
      if (sessionId)
        ({ configOptions: options } = await this.resume(
          process,
          sessionId,
          request.cwd,
        ));
      else
        ({ sessionId, configOptions: options } = await process
          .call(
            (connection) =>
              connection.newSession({ cwd: request.cwd, mcpServers: [] }),
            60_000,
          )
          .catch((error: unknown) => {
            throw new HarnessError(
              "failed",
              `OpenCode could not open a session. ${error instanceof Error ? error.message : ""}`.trim(),
            );
          }));
      return new OpenCodeSession(
        this,
        request,
        process,
        sessionId,
        options ?? [],
      );
    } finally {
      process.release();
    }
  }

  rememberCommands(cwd: string, commands: AvailableCommand[]) {
    this.commandsByFolder.set(
      cwd,
      slashCommands(
        commands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.input && "hint" in command.input
            ? { argumentHint: command.input.hint }
            : {}),
        })),
      ),
    );
  }

  /** The commands OpenCode last announced for a folder; empty until a session opens there. */
  async commands(request: LaunchContext & { cwd: string }) {
    return this.commandsByFolder.get(request.cwd) ?? [];
  }

  close() {
    this.closed = true;
    for (const process of [...this.processes.values()]) process.close();
    this.processes.clear();
  }
}
