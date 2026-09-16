import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export class OAuthCallback {
  private server?: Server;
  private reject?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  async start(
    port = 54329,
    timeout = 300_000,
  ): Promise<{ redirectTo: string; code: Promise<string> }> {
    if (this.server) throw new Error("A sign-in window is already open.");
    const state = randomBytes(32).toString("hex");
    let resolveCode!: (code: string) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      this.reject = reject;
    });
    // A bind failure can happen before the consumer receives this promise.
    void code.catch(() => {});
    this.server = createServer((req, res) => {
      const address = this.server?.address();
      const host = `127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
      const url = new URL(req.url ?? "/", `http://${host}`);
      const returnedState = Buffer.from(url.searchParams.get("state") ?? "");
      if (
        req.method !== "GET" ||
        req.headers.host !== host ||
        url.pathname !== "/auth/callback" ||
        returnedState.length !== state.length ||
        !timingSafeEqual(returnedState, Buffer.from(state))
      ) {
        res.writeHead(400).end("Invalid sign-in callback.");
        return;
      }
      const value = url.searchParams.get("code");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'",
        "Referrer-Policy": "no-referrer",
      });
      res.end(
        '<!doctype html><title>Multiplayer AI</title><body style="font:18px system-ui;padding:48px;background:#171717;color:#eee"><h1>Return to Multiplayer AI</h1><p>You can close this browser tab. The desktop app will show your sign-in result.</p>',
      );
      if (value && value.length < 4096) resolveCode(value);
      else
        this.reject?.(
          new Error("GitHub sign-in was declined or did not return a code."),
        );
      this.close();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(port, "127.0.0.1", resolve);
      });
    } catch {
      this.cancel();
      throw new Error(
        "The sign-in callback port is busy. Close the other sign-in attempt and retry.",
      );
    }
    this.timer = setTimeout(
      () => this.cancel("Sign-in expired after 5 minutes. Try again."),
      timeout,
    );
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Sign-in callback unavailable.");
    return {
      redirectTo: `http://127.0.0.1:${address.port}/auth/callback?state=${state}`,
      code,
    };
  }
  cancel(message = "Sign-in cancelled.") {
    this.reject?.(new Error(message));
    this.close();
  }
  private close() {
    clearTimeout(this.timer);
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
    this.reject = undefined;
  }
}
