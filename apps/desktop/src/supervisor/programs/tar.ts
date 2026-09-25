import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { Writable } from "node:stream";

const BLOCK = 512;

const field = (header: Buffer, start: number, length: number) =>
  header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
const octal = (header: Buffer, start: number, length: number) =>
  parseInt(field(header, start, length).trim() || "0", 8);

/** Rejects absolute paths and `..` so an archive can only write inside its target folder. */
function safePath(root: string, name: string): string {
  const relative = normalize(name.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (
    !relative ||
    isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative) ||
    relative.split(/[\\/]/).includes("..")
  )
    throw new Error(`The harness archive has an unsafe path: ${name}`);
  const target = join(root, relative);
  if (!target.startsWith(root + sep))
    throw new Error(`Unsafe archive path: ${name}`);
  return target;
}

/**
 * A minimal streaming ustar extractor for harness packages: regular files and folders, with pax
 * and GNU long names. Links and other entry types are refused.
 */
export function extractTar(root: string): Writable {
  let buffer: Buffer = Buffer.alloc(0);
  let file:
    { handle: FileHandle; remaining: number; padding: number } | undefined;
  let skip = 0;
  let longName: string | undefined;
  let paxName: string | undefined;
  let paxBody:
    | {
        kind: "long" | "pax" | "global";
        remaining: number;
        padding: number;
        chunks: Buffer[];
      }
    | undefined;
  let ended = false;

  async function header(block: Buffer) {
    if (block.every((byte) => byte === 0)) {
      ended = true;
      return;
    }
    const type = String.fromCharCode(block[156] || 48);
    const size = octal(block, 124, 12);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    const prefix = field(block, 345, 155);
    const name =
      longName ??
      paxName ??
      (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    if (type === "L" || type === "x" || type === "g") {
      const kind = type === "L" ? "long" : type === "x" ? "pax" : "global";
      paxBody = { kind, remaining: size, padding, chunks: [] };
      return;
    }
    longName = undefined;
    paxName = undefined;
    const target = safePath(root, name);
    if (type === "5") {
      await mkdir(target, { recursive: true });
      skip = size + padding;
      return;
    }
    if (type !== "0")
      throw new Error(`The harness archive has an unsupported entry: ${name}`);
    await mkdir(join(target, ".."), { recursive: true });
    const handle = await open(target, "wx", 0o644);
    const mode = octal(block, 100, 8);
    if (mode & 0o111 && process.platform !== "win32")
      await chmod(target, 0o755);
    file = { handle, remaining: size, padding };
    if (!size) {
      await handle.close();
      file = undefined;
      skip = padding;
    }
  }

  async function consume() {
    while (!ended) {
      if (skip) {
        const taken = Math.min(skip, buffer.length);
        buffer = buffer.subarray(taken);
        skip -= taken;
        if (skip) return;
        continue;
      }
      if (paxBody) {
        const taken = Math.min(paxBody.remaining, buffer.length);
        paxBody.chunks.push(buffer.subarray(0, taken));
        buffer = buffer.subarray(taken);
        paxBody.remaining -= taken;
        if (paxBody.remaining) return;
        const body = Buffer.concat(paxBody.chunks).toString("utf8");
        if (paxBody.kind === "long") longName = body.replace(/\0.*$/s, "");
        else if (paxBody.kind === "pax")
          paxName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body)?.[1] ?? paxName;
        skip = paxBody.padding;
        paxBody = undefined;
        continue;
      }
      if (file) {
        const taken = Math.min(file.remaining, buffer.length);
        if (taken) await file.handle.write(buffer.subarray(0, taken));
        buffer = buffer.subarray(taken);
        file.remaining -= taken;
        if (file.remaining) return;
        await file.handle.close();
        skip = file.padding;
        file = undefined;
        continue;
      }
      if (buffer.length < BLOCK) return;
      const block = buffer.subarray(0, BLOCK);
      buffer = buffer.subarray(BLOCK);
      await header(block);
    }
  }

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      consume().then(() => callback(), callback);
    },
    final(callback) {
      if (file || paxBody)
        callback(new Error("The harness archive ended early."));
      else callback();
    },
    destroy(error, callback) {
      void file?.handle.close().catch(() => {});
      callback(error);
    },
  });
}
