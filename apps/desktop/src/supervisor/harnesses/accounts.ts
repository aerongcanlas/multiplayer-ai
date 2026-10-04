import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { HarnessId } from "../../shared/tabs";

/** The variable each harness reads its home folder from (KTD1). */
export type HomeVariable = "CLAUDE_CONFIG_DIR" | "CODEX_HOME";

/** Where the host keeps its own setup: the home folder and each harness's folder variable. */
export type HostPaths = Partial<
  Record<"HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME", string>
>;
const HOST_PATHS = [
  "HOME",
  "USERPROFILE",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const;

/** The location variables of a raw host environment, and nothing else from it. */
export function hostPaths(env: Record<string, string | undefined>): HostPaths {
  return Object.fromEntries(
    HOST_PATHS.flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
  ) as HostPaths;
}

/** The host user's home folder. */
export const hostHome = (host: HostPaths) =>
  host.HOME || host.USERPROFILE || homedir();

/** The variable each harness's app home is named by; OpenCode uses the host's own folders. */
export const HOME_VARIABLES: Partial<Record<HarnessId, HomeVariable>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/** How a harness's app home is laid out and which host setup carries over into it (KTD4). */
export interface AccountSpec {
  variable: HomeVariable;
  /** The host's own folder for this harness; left out, nothing carries over. */
  source?: (host: HostPaths) => string;
  /** Host files and folders linked into the home. */
  links?: string[];
  /** Host files copied into the home, because the harness will not write through a link. */
  copies?: string[];
  /** Links each host `projects/<name>/memory` folder, and nothing else under `projects/`. */
  projectMemory?: boolean;
}

type EntryKind = "symlink" | "junction" | "copy";
interface Entry {
  kind: EntryKind;
  target: string;
  // Copies: the hash of the content the app wrote.
  hash?: string;
}
interface Manifest {
  version: 1;
  entries: Record<string, Entry>;
}

const MANIFEST = ".multiplayer-links.json";
// Credentials, account files, and transcripts never carry over, even when a spec lists them.
const NEVER = new Set([
  ".credentials.json",
  ".claude.json",
  "auth.json",
  "sessions",
  "projects",
  MANIFEST,
]);

export class AccountError extends Error {}

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const missing = (error: unknown) => code(error) === "ENOENT";

async function hashOf(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function info(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** The host's environment with the harness home path the app prepared laid over it. */
export function withHome(
  env: Record<string, string>,
  variable: HomeVariable,
  home: string,
) {
  return { ...env, [variable]: home };
}

/**
 * Throws unless the launch environment names the prepared home, so no harness program runs
 * against the host's own folder. With `accounts`, the home must also be that root's.
 */
export function assertHome(
  context: { env: Record<string, string>; home: string },
  variable: HomeVariable,
  accounts?: Accounts,
) {
  const { env, home } = context;
  if (
    !home ||
    env[variable] !== home ||
    (accounts &&
      (!accounts.root || !home.startsWith(resolve(accounts.root) + sep)))
  )
    throw new AccountError(
      "The harness's app folder is not ready, so it was not started.",
    );
}

/**
 * App-owned harness homes under one accounts root. Each prepare creates the home and reconciles
 * the host setup carried into it; runs on one home are serialized.
 */
export class Accounts {
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    readonly root: string | undefined,
    private platform: NodeJS.Platform = process.platform,
  ) {}

  /** The home folder a harness's variable must name. */
  home(harness: HarnessId) {
    if (!this.root)
      throw new AccountError(
        "This app has no folder for harness sign-ins. Restart the app to retry.",
      );
    return resolve(this.root, harness);
  }

  /** Creates the home and links host setup into it. Throws when the home cannot be made. */
  prepare(
    harness: HarnessId,
    spec: AccountSpec,
    host: HostPaths,
  ): Promise<string> {
    let home: string;
    try {
      home = this.home(harness);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const previous = this.chains.get(home) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.reconcile(home, spec, host));
    this.chains.set(home, run);
    return run.then(
      () => home,
      (error: unknown) => {
        throw new AccountError(
          `The app could not prepare its ${harness} folder: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  private async reconcile(home: string, spec: AccountSpec, host: HostPaths) {
    await mkdir(this.root!, { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (this.platform !== "win32") await chmod(home, 0o700);
    if (!spec.source) return;
    const source = resolve(spec.source(host));
    // A host whose own folder is the app's would link the home into itself.
    const real = await realpath(source).catch(() => source);
    if (real === (await realpath(home))) return;

    const desired = await this.desired(source, spec);
    const manifest = await this.read(home);
    for (const [name, entry] of Object.entries(manifest.entries))
      if (!desired.has(name)) {
        await this.remove(home, name, entry);
        delete manifest.entries[name];
      }
    for (const [name, want] of desired) {
      const entry = await this.converge(
        home,
        name,
        want,
        manifest.entries[name],
      );
      if (entry) manifest.entries[name] = entry;
      else delete manifest.entries[name];
    }
    await this.write(home, manifest);
  }

  /** Every host entry the spec carries over that exists on the host right now. */
  private async desired(source: string, spec: AccountSpec) {
    const result = new Map<string, Entry>();
    const add = async (name: string, copy: boolean) => {
      const target = join(source, name);
      const found = await stat(target).catch(() => null);
      if (!found) return;
      const directory = found.isDirectory();
      // Windows links folders as junctions and copies files; symlinks need extra rights there.
      const kind: EntryKind =
        copy || (this.platform === "win32" && !directory)
          ? "copy"
          : this.platform === "win32"
            ? "junction"
            : "symlink";
      if (kind === "copy" && directory) return;
      result.set(name, { kind, target });
    };
    for (const name of spec.links ?? [])
      if (!NEVER.has(name) && !name.includes("/") && !name.includes(sep))
        await add(name, false);
    for (const name of spec.copies ?? [])
      if (!NEVER.has(name) && !name.includes("/") && !name.includes(sep))
        await add(name, true);
    if (spec.projectMemory) {
      const projects = join(source, "projects");
      const names = await readdir(projects).catch(() => [] as string[]);
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const memory = join(projects, name, "memory");
        const found = await stat(memory).catch(() => null);
        if (found?.isDirectory())
          result.set(`projects/${name}/memory`, {
            kind: this.platform === "win32" ? "junction" : "symlink",
            target: memory,
          });
      }
    }
    return result;
  }

  /** Brings one entry to what the host has, returning what the manifest should record. */
  private async converge(
    home: string,
    name: string,
    want: Entry,
    recorded: Entry | undefined,
  ): Promise<Entry | undefined> {
    const path = join(home, ...name.split("/"));
    const current = await info(path);
    if (!current) {
      await mkdir(dirname(path), { recursive: true });
      return this.create(path, want);
    }
    // Real files the harness made itself stay untouched.
    if (!recorded) return undefined;
    if (want.kind === "copy") {
      if (current.isSymbolicLink() || !current.isFile()) {
        await this.backup(path);
        return this.create(path, want);
      }
      const hash = await hashOf(path);
      if (hash !== recorded.hash) {
        // The harness changed its copy; keep that edit beside the refreshed file.
        await this.backup(path);
        return this.create(path, want);
      }
      if ((await hashOf(want.target)) !== recorded.hash)
        return this.create(path, want);
      return recorded;
    }
    if (current.isSymbolicLink()) {
      const target = await readlink(path).catch(() => "");
      if (resolve(dirname(path), target) === want.target) return recorded;
      await unlink(path);
      return this.create(path, want);
    }
    // A link the harness replaced with a real file (AE8).
    await this.backup(path);
    return this.create(path, want);
  }

  private async create(path: string, want: Entry): Promise<Entry> {
    try {
      if (want.kind === "copy") {
        const temporary = `${path}.${randomUUID()}.tmp`;
        await copyFile(want.target, temporary);
        await rename(temporary, path);
        return { ...want, hash: await hashOf(path) };
      }
      await symlink(
        want.target,
        path,
        want.kind === "junction" ? "junction" : undefined,
      );
    } catch (error) {
      // Another prepare (another dev checkout) made it first; the next launch re-checks it.
      if (code(error) !== "EEXIST") throw error;
    }
    return want;
  }

  /** Removes an entry whose host source is gone; anything the harness changed is kept aside. */
  private async remove(home: string, name: string, entry: Entry) {
    const path = join(home, ...name.split("/"));
    const current = await info(path);
    if (!current) return;
    if (current.isSymbolicLink() && entry.kind !== "copy") {
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
      return;
    }
    if (
      entry.kind === "copy" &&
      current.isFile() &&
      (await hashOf(path)) === entry.hash
    ) {
      await rm(path, { force: true });
      return;
    }
    await this.backup(path);
  }

  /** Moves a file aside as `<name>.app-<date>.bak`. */
  private async backup(path: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let target = `${path}.app-${stamp}.bak`;
    for (let index = 1; await info(target); index++)
      target = `${path}.app-${stamp}-${index}.bak`;
    try {
      await rename(path, target);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  private async read(home: string): Promise<Manifest> {
    try {
      const parsed = JSON.parse(
        await readFile(join(home, MANIFEST), "utf8"),
      ) as Manifest;
      if (
        parsed?.version === 1 &&
        parsed.entries &&
        typeof parsed.entries === "object"
      )
        return parsed;
    } catch {
      /* A missing or damaged manifest starts empty. */
    }
    return { version: 1, entries: {} };
  }

  private async write(home: string, manifest: Manifest) {
    const file = join(home, MANIFEST);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    await rename(temporary, file);
  }
}
