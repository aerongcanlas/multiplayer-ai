import { randomUUID } from "node:crypto";
import {
  RequestError,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Loadout } from "../../../shared/tabs";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessSession,
  type OpenRequest,
} from "../contract";
import { clip, object, string } from "../json";
import { EventQueue } from "../queue";
import type { OpenCodeAdapter } from "./adapter";
import { outsideCheckout, toolDetail, toolSummary, TurnEvents } from "./events";
import type { OpenCodeProcess } from "./process";

/** The option of a kind, or a cancelled outcome when OpenCode offered none. */
export function choose(
  options: PermissionOption[],
  kind: PermissionOption["kind"],
): RequestPermissionResponse {
  const option = options.find((item) => item.kind === kind);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

const values = (options: SessionConfigOption[], id: string) => {
  const option = options.find((item) => item.id === id);
  if (option?.type !== "select") return null;
  return option.options.flatMap((item) =>
    "value" in item ? [item.value] : item.options.map((entry) => entry.value),
  );
};

/** Maps a failed prompt onto a harness failure with a fixed message. */
function promptError(error: unknown): HarnessError {
  if (error instanceof HarnessError) return error;
  if (error instanceof RequestError && error.code === -32000) {
    const provider = string(object(error.data).providerId);
    return new HarnessError(
      "signed_out",
      `OpenCode needs a login${provider ? ` for ${provider}` : ""}. Sign it in with the command in Settings, then send a follow-up.`,
    );
  }
  const detail = error instanceof Error ? clip(error.message, 300) : "";
  return new HarnessError(
    "failed",
    `OpenCode could not finish this turn${detail ? `: ${detail}` : "."}`,
  );
}

interface Pending {
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
}

export class OpenCodeSession implements HarnessSession {
  private queue?: EventQueue<HarnessEvent>;
  private turn?: { events: TurnEvents; loadout: Loadout };
  private pending = new Map<string, Pending>();
  private stopRequested = false;
  private prompting?: Promise<unknown>;
  private announced: boolean;
  private closed = false;

  constructor(
    private adapter: OpenCodeAdapter,
    private request: OpenRequest,
    public process: OpenCodeProcess,
    readonly sessionId: string,
    private options: SessionConfigOption[],
  ) {
    this.announced = Boolean(request.sessionId);
    process.sessions.set(sessionId, this);
  }

  get active() {
    return Boolean(this.queue && !this.queue.ended);
  }

  private async setOption(configId: string, value: string) {
    const result = await this.process.call(
      (connection) =>
        connection.setSessionConfigOption({
          sessionId: this.sessionId,
          configId,
          value,
        }),
      30_000,
    );
    this.options = result.configOptions;
  }

  /** The tab's model, retried once when OpenCode's first catalog lacked it (issue #52926). */
  private async setModel(model: string) {
    try {
      await this.setOption("model", model);
    } catch (error) {
      const listed = values(this.options, "model");
      if (listed && !listed.includes(model)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          return await this.setOption("model", model);
        } catch {
          /* Reported below. */
        }
      }
      if (!(error instanceof RequestError)) throw error;
      throw new HarnessError(
        "failed",
        `OpenCode does not offer ${model} right now. Refresh models in Settings or choose another model.`,
      );
    }
  }

  async *send(prompt: string, loadout: Loadout): AsyncIterable<HarnessEvent> {
    this.stopRequested = false;
    await this.adapter.place(this, this.request);
    const process = this.process;
    process.hold();
    const queue = new EventQueue<HarnessEvent>();
    this.queue = queue;
    this.turn = { events: new TurnEvents(randomUUID()), loadout };
    try {
      if (!this.announced) {
        this.announced = true;
        queue.push({ type: "session", sessionId: this.sessionId });
      }
      await this.setModel(loadout.model);
      // Plan mode is OpenCode's own plan agent; every other turn runs build.
      await this.setOption("mode", loadout.planMode ? "plan" : "build");
      const efforts = values(this.options, "effort");
      if (efforts)
        await this.setOption(
          "effort",
          loadout.effort && efforts.includes(loadout.effort)
            ? loadout.effort
            : "default",
        );
      if (this.stopRequested) return;
      this.prompting = process
        .call((connection) =>
          connection.prompt({
            sessionId: this.sessionId,
            prompt: [{ type: "text", text: prompt }],
          }),
        )
        .then((result) => {
          if (result.stopReason === "max_tokens")
            queue.push({
              type: "notice",
              summary:
                "The model reached its output limit, so this reply may be cut short.",
            });
          else if (result.stopReason === "refusal")
            queue.push({
              type: "notice",
              summary: "The model declined to continue this turn.",
            });
          queue.end();
        })
        .catch(async (error) => {
          if (this.stopRequested) return queue.end();
          // The connection can close just before the exit is seen; an exit fails the turn
          // through `crashed`.
          if (!(await process.ending(1_000))) queue.fail(promptError(error));
        });
      yield* queue;
    } catch (error) {
      if (this.stopRequested) return;
      if (error instanceof HarnessError) throw error;
      throw (await process.ending(1_000))
        ? this.crash(error instanceof Error ? error.message : "")
        : promptError(error);
    } finally {
      this.queue = undefined;
      this.turn = undefined;
      this.prompting = undefined;
      this.cancelPending();
      process.release();
    }
  }

  update({ update }: SessionNotification) {
    if (update.sessionUpdate === "available_commands_update") {
      this.adapter.rememberCommands(this.request.cwd, update.availableCommands);
      return;
    }
    if (!this.active || !this.turn) return;
    for (const event of this.turn.events.map(update)) this.queue!.push(event);
  }

  /** Routes OpenCode's permission request through the tab's access mode (KTD5). */
  permission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const { options, toolCall } = params;
    if (!this.active || !this.turn)
      return Promise.resolve(choose(options, "reject_once"));
    const outside = outsideCheckout(toolCall);
    const title = clip(string(toolCall.title) || "a tool", 400);
    if (this.turn.loadout.access === "auto") {
      if (!outside) return Promise.resolve(choose(options, "allow_once"));
      // "Act without asking" never reaches outside the checkout.
      this.queue!.push({
        type: "notice",
        summary: `Refused access outside this checkout: ${title}`,
      });
      return Promise.resolve(choose(options, "reject_once"));
    }
    const request = randomUUID();
    const input = object(toolCall.rawInput);
    const detail =
      toolDetail(toolCall.content) ??
      (Object.keys(input).length
        ? clip(JSON.stringify(input, null, 2), 20_000)
        : undefined);
    this.queue!.push({
      type: "approval",
      request,
      summary: outside
        ? `Access outside this checkout: ${title}`
        : toolCall.kind === "execute"
          ? `Run command: ${clip(string(input.command) || title)}`
          : toolSummary(title, toolCall.kind),
      ...(detail ? { detail } : {}),
    });
    return new Promise((resolve) =>
      this.pending.set(request, { options, resolve }),
    );
  }

  respond(request: string, decision: "accept" | "decline") {
    const pending = this.pending.get(request);
    if (!pending) throw new Error("That request is no longer pending.");
    this.pending.delete(request);
    pending.resolve(
      choose(
        pending.options,
        decision === "accept" ? "allow_once" : "reject_once",
      ),
    );
  }

  answer(): void {
    throw new Error("OpenCode does not ask questions in this app.");
  }

  private cancelPending() {
    for (const pending of this.pending.values())
      pending.resolve({ outcome: { outcome: "cancelled" } });
    this.pending.clear();
  }

  async stop() {
    this.stopRequested = true;
    this.cancelPending();
    if (!this.process.alive) return;
    await this.process
      .call(
        (connection) => connection.cancel({ sessionId: this.sessionId }),
        5_000,
      )
      .catch(() => {});
    // The turn ends once OpenCode reports it cancelled, or after the timeout regardless.
    const prompting = this.prompting;
    if (prompting)
      await Promise.race([
        prompting.catch(() => {}),
        new Promise((resolve) =>
          setTimeout(resolve, this.adapter.stopTimeoutMs).unref?.(),
        ),
      ]);
    this.queue?.end();
  }

  private crash(message: string) {
    return new HarnessError(
      "crashed",
      `OpenCode stopped during this turn. ${message} The next message restarts it.`,
    );
  }

  crashed(message: string) {
    this.cancelPending();
    if (this.active) return this.queue!.fail(this.crash(message));
    if (!this.closed)
      this.request.listener?.({
        type: "crashed",
        message: `OpenCode stopped. ${message} The next message restarts it.`,
      });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.active) void this.stop().catch(() => {});
    this.process.sessions.delete(this.sessionId);
    // A draining process closes once nothing runs there; an idle one times out.
    this.process.touch();
  }
}
