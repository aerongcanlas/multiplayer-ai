import type { SessionEvent } from "./contract";

/**
 * Delivers a session's events to the host. Events of a turn the harness started by itself are held
 * while the owner's turn is still open, so the host never sees a new turn start inside the old one.
 */
export class SessionRelay {
  private backlog: SessionEvent[] = [];
  private flushing = false;
  closed = false;

  constructor(
    private listener: ((event: SessionEvent) => void) | undefined,
    private ownerTurnOpen: () => boolean,
  ) {}

  send(event: SessionEvent) {
    if (!this.closed) this.listener?.(event);
  }

  /** Sends a harness-turn event, or holds it until `flush` once the owner's turn has ended. */
  hold(event: SessionEvent) {
    if (this.ownerTurnOpen() || this.flushing) this.backlog.push(event);
    else this.send(event);
  }

  flush() {
    if (!this.backlog.length || this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      for (const event of this.backlog.splice(0)) this.send(event);
    });
  }
}
