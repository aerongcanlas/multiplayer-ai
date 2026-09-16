import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Auth tokens and PKCE verifier never enter the renderer, SQLite journal, or supervisor. */
export class AuthStorage {
  private values: Record<string, string> = {};
  private file: string;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    directory: string,
    private encryption: Encryption,
    private replaceFile: (
      source: string,
      destination: string,
    ) => Promise<void> = rename,
  ) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "supabase-session.bin");
    if (existsSync(this.file)) {
      if (!encryption.isEncryptionAvailable())
        throw new Error(
          "Unlock your operating-system credential store to sign in.",
        );
      try {
        const values: unknown = JSON.parse(
          encryption.decryptString(readFileSync(this.file)),
        );
        if (
          !values ||
          typeof values !== "object" ||
          Array.isArray(values) ||
          Object.values(values).some((v) => typeof v !== "string")
        )
          throw new Error();
        this.values = values as Record<string, string>;
      } catch {
        throw new Error(
          "Saved sign-in could not be decrypted. Use a new desktop profile or restore access to your operating-system credential store.",
        );
      }
    }
  }
  async getItem(key: string) {
    await this.queue;
    return this.values[key] ?? null;
  }
  setItem(key: string, value: string) {
    return this.change((values) => ({ ...values, [key]: value }));
  }
  removeItem(key: string) {
    return this.change((values) => {
      const next = { ...values };
      delete next[key];
      return next;
    });
  }
  private change(
    update: (values: Record<string, string>) => Record<string, string>,
  ) {
    // Serialize updates and reads so retries cannot lose a newer token or a sign-out.
    const pending = this.queue.then(() => this.persist(update(this.values)));
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async persist(next: Record<string, string>) {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error(
        "Operating-system encryption is required to save sign-in.",
      );
    const temporary = this.file + ".tmp";
    await writeFile(
      temporary,
      this.encryption.encryptString(JSON.stringify(next)),
      { mode: 0o600 },
    );
    // Windows scanners may briefly hold the file open. Retry the atomic rename
    // without blocking Electron's main thread or publishing an unpersisted value.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.replaceFile(temporary, this.file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? ""))
          throw error;
        await delay(25 * 2 ** attempt);
      }
    }
    this.values = next;
  }
}
