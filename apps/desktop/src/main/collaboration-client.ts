import {
  createClient,
  type SupabaseClient,
  type Session,
} from "@supabase/supabase-js";
import { z } from "zod";
import {
  asSharedRoom,
  sharedSnapshotSchema,
  signedOutState,
  type CollaborationState,
  type RoomNotice,
} from "../shared/collaboration";
import type { Command, Room } from "../shared/contracts";

// How a read-along call ended. Read-along never reports through the room-wide status.
export type ReadAlongOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: "not_member" | "migration_missing" | "invalid" | "retry";
    };
export type ReadAlongRpc =
  | "desktop_tab_share_publish"
  | "desktop_tab_share_head"
  | "desktop_tab_share_pull"
  | "desktop_tab_share_reconcile";

/** Maps a read-along RPC error without touching collaboration state. */
export function readAlongFailure(error: {
  code?: string;
}): "not_member" | "migration_missing" | "invalid" | "retry" {
  if (error.code === "42501") return "not_member";
  // The server refused the arguments; sending them again cannot succeed.
  if (error.code === "22023") return "invalid";
  if (["PGRST202", "42883", "42P01"].includes(error.code ?? ""))
    return "migration_missing";
  return "retry";
}
import type { AuthStorage } from "./auth-storage";
import { OAuthCallback } from "./oauth-callback";

export class CollaborationClient {
  state: CollaborationState = signedOutState();
  rooms: Room[] = [];
  private client: SupabaseClient;
  private callback = new OAuthCallback();
  private epoch = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private queue: Promise<unknown> = Promise.resolve();
  // Read-along publishes and pulls queue here, so they never delay refreshes or commands.
  private readAlongQueue: Promise<unknown> = Promise.resolve();
  private refreshing?: Promise<void>;
  private closed = false;
  private allowSession = true;
  private exchanging = false;
  private subscription: { unsubscribe(): void };
  private storageKey = "multiplayer-desktop-auth";

  constructor(
    private config: { url: string; publishableKey: string; apiUrl?: string },
    private storage: AuthStorage,
    private openBrowser: (url: string) => Promise<void>,
    private changed: () => void,
    testing = false,
    allowLocalApi = false,
  ) {
    const url = new URL(config.url);
    if (
      !(
        url.protocol === "https:" &&
        /^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
      ) &&
      !(testing && url.protocol === "http:" && url.hostname === "127.0.0.1")
    )
      throw new Error("Invalid Supabase project URL.");
    if (!config.publishableKey.startsWith("sb_publishable_"))
      throw new Error("Desktop requires a public Supabase publishable key.");
    if (config.apiUrl) {
      const api = new URL(config.apiUrl);
      if (
        api.username ||
        api.password ||
        api.search ||
        api.hash ||
        api.pathname !== "/" ||
        !(
          api.protocol === "https:" ||
          ((testing || allowLocalApi) &&
            api.protocol === "http:" &&
            api.hostname === "127.0.0.1")
        )
      )
        throw new Error(
          "Shared-room API requires an HTTPS origin (loopback is allowed in development).",
        );
    }
    this.client = createClient(config.url, config.publishableKey, {
      auth: {
        flowType: "pkce",
        storage,
        storageKey: this.storageKey,
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
      },
    });
    this.subscription = this.client.auth.onAuthStateChange(
      (_event, session) => {
        if (this.closed) return;
        this.sessionChanged(session);
      },
    ).data.subscription;
    this.refreshTimer = setInterval(() => {
      if (this.state.auth === "signed_in") void this.refresh().catch(() => {});
    }, 4_000);
  }

  private sessionChanged(session: Session | null) {
    if (session && !this.allowSession) {
      void this.storage.removeItem(this.storageKey).catch(() => {
        this.state = {
          ...signedOutState(),
          message:
            "Could not clear saved sign-in. Close other processes using this desktop profile, then sign out again.",
        };
        this.changed();
      });
      setTimeout(() => {
        void this.client.auth.signOut({ scope: "local" });
      }, 0);
      return;
    }
    const old = this.state.account?.id;
    if (session) {
      this.state = {
        ...this.state,
        auth: "signed_in",
        account: {
          id: session.user.id,
          name:
            session.user.user_metadata?.user_name ??
            session.user.user_metadata?.name ??
            "Member",
        },
      };
      if (old !== session.user.id) {
        this.epoch++;
        this.rooms = [];
        this.state.status = "syncing";
        this.state.lastSyncedAt = null;
        // Never await an auth operation inside Supabase's auth-state callback.
        setTimeout(() => {
          void this.refresh().catch(() => {});
        }, 0);
      }
    } else if (this.state.auth !== "signing_in") {
      this.epoch++;
      this.rooms = [];
      this.state = signedOutState();
    }
    this.changed();
  }

  async signIn() {
    if (this.state.auth !== "signed_out")
      throw new Error("Sign out or cancel the current sign-in first.");
    if (this.exchanging)
      throw new Error(
        "The cancelled sign-in is finishing. Try again in 15 seconds.",
      );
    this.allowSession = true;
    this.state = {
      ...signedOutState(),
      auth: "signing_in",
      message: "Finish GitHub sign-in in your browser.",
    };
    this.changed();
    const epoch = ++this.epoch;
    try {
      const { redirectTo, code } = await this.callback.start();
      const { data, error } = await this.client.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error || !data.url)
        throw new Error("Could not start GitHub sign-in.");
      const url = new URL(data.url);
      if (
        url.origin !== new URL(this.config.url).origin ||
        url.pathname !== "/auth/v1/authorize"
      )
        throw new Error("Unexpected sign-in destination.");
      void code
        .then(async (value) => {
          if (this.closed || epoch !== this.epoch) return;
          this.exchanging = true;
          try {
            const { error } =
              await this.client.auth.exchangeCodeForSession(value);
            if (error)
              throw new Error(
                "Could not finish sign-in. Check the desktop callback URL in Supabase and try again.",
              );
          } finally {
            this.exchanging = false;
          }
        })
        .catch((error) => {
          if (this.closed || epoch !== this.epoch) return;
          this.state = {
            ...signedOutState(),
            message: error instanceof Error ? error.message : "Sign-in failed.",
          };
          this.changed();
        });
      await this.openBrowser(data.url);
    } catch (error) {
      await this.cancelSignIn();
      throw error;
    }
  }
  async cancelSignIn() {
    if (this.state.auth !== "signing_in") return;
    this.allowSession = false;
    this.epoch++;
    this.callback.cancel();
    this.state = signedOutState();
    this.changed();
    await this.storage.removeItem(this.storageKey + "-code-verifier");
  }
  async signOut() {
    this.allowSession = false;
    this.epoch++;
    this.callback.cancel();
    this.rooms = [];
    this.state = signedOutState();
    this.changed();
    // Clear local credentials even when the network is unavailable; remote sessions on other devices remain valid.
    await this.storage.removeItem(this.storageKey);
    await this.storage.removeItem(this.storageKey + "-code-verifier");
    await this.client.auth.signOut({ scope: "local" });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  /** The account epoch; read-along results from an older epoch are dropped. */
  get currentEpoch() {
    return this.epoch;
  }
  /**
   * Calls a read-along RPC on its own queue. Results for a changed account resolve as `retry`
   * with the caller expected to check `currentEpoch`; failures never flip collaboration status.
   */
  readAlong<T>(
    name: ReadAlongRpc,
    args: Record<string, unknown>,
  ): Promise<ReadAlongOutcome<T>> {
    const epoch = this.epoch;
    const work = async (): Promise<ReadAlongOutcome<T>> => {
      if (this.state.auth !== "signed_in" || epoch !== this.epoch)
        return { ok: false, reason: "retry" };
      try {
        const { data, error } = await this.client.rpc(name, args);
        if (epoch !== this.epoch) return { ok: false, reason: "retry" };
        if (error) return { ok: false, reason: readAlongFailure(error) };
        return { ok: true, data: data as T };
      } catch {
        return { ok: false, reason: "retry" };
      }
    };
    const next = this.readAlongQueue.then(work, work);
    this.readAlongQueue = next.catch(() => {});
    return next;
  }
  private accept(data: unknown, epoch: number) {
    if (this.closed || epoch !== this.epoch)
      throw new Error(
        "The signed-in account changed. Retry with your current account.",
      );
    const snapshot = sharedSnapshotSchema.parse(data);
    if (snapshot.userId !== this.state.account?.id)
      throw new Error("Shared room identity mismatch. Sign in again.");
    this.rooms = snapshot.rooms.map((room) =>
      asSharedRoom(room, snapshot.userId, this.config.url),
    );
    const serverNow = snapshot.now ? Date.parse(snapshot.now) : NaN;
    this.state = {
      ...this.state,
      status: "connected",
      message: null,
      lastSyncedAt: new Date().toISOString(),
      ...(Number.isFinite(serverNow)
        ? { clockOffsetMs: serverNow - Date.now() }
        : {}),
    };
    this.changed();
  }
  private failure(error: { code?: string; message?: string }) {
    const missing = ["setup_required", "PGRST202", "42883", "42P01"].includes(
      error.code ?? "",
    );
    const message = missing
      ? (error.message ??
        "Shared rooms need API configuration and current database migrations. See the setup instructions.")
      : error.code && !error.code.startsWith("PGRST")
        ? (error.message ?? "Shared room operation failed.")
        : "Shared rooms could not sync. Check your connection, then refresh before retrying.";
    this.state = {
      ...this.state,
      status: missing ? "setup_required" : "offline",
      message,
    };
    this.changed();
    return new Error(message);
  }
  private async api(
    path: string,
    epoch: number,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    if (!this.config.apiUrl)
      throw Object.assign(
        new Error(
          "Configure the shared-room API URL. See the shared rooms setup instructions.",
        ),
        { code: "setup_required" },
      );
    const { data, error } = await this.client.auth.getSession();
    if (this.closed || epoch !== this.epoch)
      throw new Error("The signed-in account changed.");
    if (
      error ||
      !data.session ||
      data.session.user.id !== this.state.account?.id
    )
      throw Object.assign(new Error("Your session expired. Sign in again."), {
        code: "unauthorized",
      });
    const response = await fetch(new URL(path, this.config.apiUrl), {
      method,
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const failure = z
        .object({ code: z.string(), message: z.string() })
        .safeParse(result);
      throw Object.assign(
        new Error(
          failure.success
            ? failure.data.message
            : "Shared-room request failed.",
        ),
        {
          code: failure.success ? failure.data.code : "unavailable",
        },
      );
    }
    return result;
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const work = this.serial(async () => {
      if (this.state.auth !== "signed_in" || epoch !== this.epoch) return;
      try {
        const data = await this.api("/v1/rooms/snapshot", epoch);
        if (epoch !== this.epoch) return;
        this.accept(data, epoch);
      } catch (error) {
        if (epoch !== this.epoch) return;
        throw this.failure(error instanceof Error ? error : {});
      }
    });
    this.refreshing = work.finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  command(
    command: Command,
    generatedPrompts?: string[],
  ): Promise<RoomNotice | undefined> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (this.state.auth !== "signed_in" || epoch !== this.epoch)
        throw new Error("Sign in to use shared rooms.");
      let path: string;
      let body: unknown;
      let method = "POST";
      switch (command.type) {
        case "room.create":
          path = "/v1/rooms";
          body = { name: command.name };
          break;
        case "room.join":
          path = "/v1/invites/accept";
          body = { token: command.token };
          break;
        case "invite.create":
          path = `/v1/rooms/${command.roomId}/invites`;
          break;
        case "room.delete":
          path = `/v1/rooms/${command.roomId}`;
          method = "DELETE";
          break;
        case "room.leave":
          path = `/v1/rooms/${command.roomId}/leave`;
          break;
        case "message.send":
          path = `/v1/rooms/${command.roomId}/messages`;
          body = { text: command.text };
          break;
        case "suggestion.create":
          if (!generatedPrompts?.length)
            throw new Error(
              "Generate prompts with the context agent before saving them.",
            );
          path = `/v1/rooms/${command.roomId}/suggestions`;
          body = { messageIds: command.messageIds, prompts: generatedPrompts };
          break;
        case "suggestion.edit":
          path = `/v1/rooms/${command.roomId}/suggestions/${command.suggestionId}`;
          body = {
            prompt: command.prompt,
            expectedRevision: command.expectedRevision,
          };
          method = "PATCH";
          break;
        case "suggestion.delete":
          path = `/v1/rooms/${command.roomId}/suggestions/${command.suggestionId}`;
          method = "DELETE";
          break;
        default:
          throw new Error("Unsupported shared-room operation.");
      }
      try {
        const result = await this.api(path, epoch, method, body);
        if (epoch !== this.epoch)
          throw new Error("The signed-in account changed.");
        const data = z
          .object({
            snapshot: sharedSnapshotSchema,
            roomId: z.uuid(),
            token: z
              .string()
              .regex(/^[A-Za-z0-9_-]{43}$/)
              .optional(),
          })
          .parse(result);
        this.accept(data.snapshot, epoch);
        return data.token
          ? { kind: "invite", token: data.token }
          : ["room.create", "room.join"].includes(command.type)
            ? { kind: "room", roomId: data.roomId }
            : undefined;
      } catch (error) {
        if (epoch !== this.epoch)
          throw new Error("The signed-in account changed.");
        throw this.failure(error instanceof Error ? error : {});
      }
    });
  }
  close() {
    this.closed = true;
    this.epoch++;
    clearInterval(this.refreshTimer);
    this.callback.cancel();
    this.subscription.unsubscribe();
    void this.client.auth.stopAutoRefresh();
  }
}
