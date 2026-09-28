/** A push-driven async iterator: producers push, end, or fail; one consumer iterates. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private done = false;
  private error?: unknown;

  push(item: T) {
    if (this.done) return;
    this.items.push(item);
    this.wake?.();
  }

  end() {
    this.done = true;
    this.wake?.();
  }

  fail(error: unknown) {
    if (this.done) return;
    this.error = error;
    this.end();
  }

  get ended() {
    return this.done;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.done) {
        if (this.error) throw this.error;
        return;
      } else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
