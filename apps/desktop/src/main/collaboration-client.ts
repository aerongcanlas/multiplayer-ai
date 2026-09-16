import {
  createClient,
  type SupabaseClient,
  type Session,
} from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";
import {
  asSharedRoom,
  sharedSnapshotSchema,
  signedOutState,
  type CollaborationState,
  type RoomNotice,
} from "../shared/collaboration";
import type { Command, Room } from "../shared/contracts";
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
  private refreshing?: Promise<void>;
  private closed = false;
  private allowSession = true;
  private exchanging = false;
  private subscription: { unsubscribe(): void };
  private storageKey = "multiplayer-desktop-auth";

  constructor(
    private config: { url: string; publishableKey: string },
    private storage: AuthStorage,
    private openBrowser: (url: string) => Promise<void>,
    private changed: () => void,
    testing = false,
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
    this.state = {
      ...this.state,
      status: "connected",
      message: null,
      lastSyncedAt: new Date().toISOString(),
    };
    this.changed();
  }
  private failure(error: { code?: string; message?: string }) {
    const missing = ["PGRST202", "42883", "42P01"].includes(error.code ?? "");
    const message = missing
      ? "Shared rooms need the desktop database migration. See the setup instructions."
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
  refresh() {
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const work = this.serial(async () => {
      if (this.state.auth !== "signed_in" || epoch !== this.epoch) return;
      const { data, error } = await this.client.rpc("desktop_room_snapshot");
      if (epoch !== this.epoch) return;
      if (error) throw this.failure(error);
      this.accept(data, epoch);
    });
    this.refreshing = work.finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  command(command: Command): Promise<RoomNotice | undefined> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (this.state.auth !== "signed_in" || epoch !== this.epoch)
        throw new Error("Sign in to use shared rooms.");
      let input: Record<string, unknown> = { ...command };
      let token: string | undefined;
      if (command.type === "invite.create") {
        token = randomBytes(32).toString("base64url");
        input = {
          type: command.type,
          roomId: command.roomId,
          tokenHash: createHash("sha256").update(token).digest("hex"),
        };
      }
      if (command.type === "room.join")
        input = {
          type: command.type,
          tokenHash: createHash("sha256").update(command.token).digest("hex"),
        };
      const { data, error } = await this.client.rpc("desktop_room_command", {
        p_command: input,
      });
      if (epoch !== this.epoch)
        throw new Error("The signed-in account changed.");
      if (error) throw this.failure(error);
      this.accept(data.snapshot, epoch);
      return token
        ? { kind: "invite", token }
        : ["room.create", "room.join"].includes(command.type)
          ? { kind: "room", roomId: data.roomId }
          : undefined;
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
