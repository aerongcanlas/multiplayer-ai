import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { zstdCompressSync } from "node:zlib";
import { detectPlatform, ProgramError, ProgramManager } from "./manager";
import type { ProgramManifest } from "./types";

const binary = Buffer.from(
  "#!/bin/sh\necho fixture-harness 1.0.0\n".repeat(200),
);
const compressed = zstdCompressSync(binary);
const digest = (buffer: Buffer) => ({
  sha256: createHash("sha256").update(buffer).digest("hex"),
  size: buffer.length,
});

async function serve(
  handler: (
    path: string,
    respond: (status: number, body?: Buffer) => void,
    socket: () => void,
  ) => void,
) {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    requests++;
    handler(
      request.url ?? "",
      (status, body) => {
        response.writeHead(
          status,
          body ? { "content-length": body.length } : {},
        );
        response.end(body);
      },
      () => {
        response.writeHead(200, { "content-length": binary.length });
        // A prefix smaller than every served asset, so only the drop can fail it.
        response.write(binary.subarray(0, 10));
        setTimeout(() => response.socket?.destroy(), 20);
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const manifest = (
  url: string,
  overrides: Partial<
    ProgramManifest["codex"]["platforms"]["darwin-arm64"]
  > = {},
): ProgramManifest => ({
  codex: {
    version: "1.0.0",
    platforms: {
      "darwin-arm64": {
        url: `${url}/codex.zst`,
        file: "codex",
        download: digest(compressed),
        compression: "zstd",
        binary: digest(binary),
        ...overrides,
      },
    },
  },
  claude: {
    version: "2.0.0",
    platforms: {
      "darwin-arm64": {
        url: `${url}/claude`,
        file: "claude",
        download: digest(binary),
      },
    },
  },
  opencode: { version: "3.0.0", platforms: {} },
});

const files = async (root: string, harness: string, version: string) => {
  try {
    return await readdir(join(root, "harnesses", harness, version));
  } catch {
    return [];
  }
};

async function setup(
  overrides: Parameters<typeof manifest>[1] = {},
  handler?: Parameters<typeof serve>[0],
  options: Partial<ConstructorParameters<typeof ProgramManager>[0]> = {},
) {
  const server = await serve(
    handler ??
      ((path, respond) =>
        respond(200, path.endsWith(".zst") ? compressed : binary)),
  );
  const root = await mkdtemp(join(tmpdir(), "multiplayer-programs-"));
  const manager = new ProgramManager({
    root,
    manifest: manifest(server.url, overrides),
    platform: "darwin-arm64",
    ...options,
  });
  return { server, root, manager };
}

test("downloads, verifies, and stores a compressed program with its record", async () => {
  const { server, root, manager } = await setup();
  const progress: number[] = [];
  manager.on("progress", ({ received }) => progress.push(received));
  try {
    const first = await manager.resolve("codex");
    assert.equal(first.source, "managed");
    assert.equal(first.version, "1.0.0");
    assert.deepEqual(await readFile(first.path), binary);
    assert.ok(existsSync(`${first.path}.meta`));
    assert.equal(progress.at(-1), compressed.length);
    const second = await manager.resolve("codex");
    assert.equal(second.path, first.path);
    assert.equal(server.requests(), 1);
    assert.equal(await manager.installed("codex"), true);
    // Uncompressed assets are verified against their download digest.
    const claude = await manager.resolve("claude");
    assert.deepEqual(await readFile(claude.path), binary);
  } finally {
    await server.close();
  }
  assert.deepEqual((await files(root, "codex", "1.0.0")).sort(), [
    "codex",
    "codex.meta",
  ]);
});

test("a download with the wrong digest leaves nothing behind", async () => {
  const { server, root, manager } = await setup({
    download: { sha256: "0".repeat(64), size: compressed.length },
  });
  try {
    await assert.rejects(manager.resolve("codex"), (error: ProgramError) => {
      assert.equal(error.code, "checksum_mismatch");
      return true;
    });
  } finally {
    await server.close();
  }
  assert.deepEqual(await files(root, "codex", "1.0.0"), []);
});

test("a server that drops mid-stream reports a network failure and removes the partial file", async () => {
  const { server, root, manager } = await setup({}, (_path, _respond, drop) =>
    drop(),
  );
  try {
    await assert.rejects(manager.resolve("codex"), (error: ProgramError) => {
      assert.equal(error.code, "network");
      return true;
    });
  } finally {
    await server.close();
  }
  assert.deepEqual(await files(root, "codex", "1.0.0"), []);
});

test("a full disk reports disk_full", async () => {
  const { server, manager } = await setup({}, undefined, {
    createWriteStream: () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error("no space"), { code: "ENOSPC" }));
        },
      }),
  });
  try {
    await assert.rejects(manager.resolve("codex"), (error: ProgramError) => {
      assert.equal(error.code, "disk_full");
      return true;
    });
  } finally {
    await server.close();
  }
});

test("a binary without its record is re-verified, and replaced when it does not match", async () => {
  const { server, root, manager } = await setup();
  const directory = join(root, "harnesses", "codex", "1.0.0");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, "codex"), binary);
    const kept = await manager.resolve("codex");
    assert.equal(server.requests(), 0);
    assert.ok(existsSync(`${kept.path}.meta`));

    await writeFile(join(directory, "codex"), "tampered");
    await writeFile(
      join(directory, "codex.meta"),
      JSON.stringify({ sha256: "stale", size: 8 }),
    );
    const replaced = await manager.resolve("codex");
    assert.equal(server.requests(), 1);
    assert.deepEqual(await readFile(replaced.path), binary);
  } finally {
    await server.close();
  }
});

test("a compressed asset whose unpacked digest does not match is rejected", async () => {
  const { server, root, manager } = await setup({
    binary: { sha256: "1".repeat(64), size: binary.length },
  });
  try {
    await assert.rejects(manager.resolve("codex"), (error: ProgramError) => {
      assert.equal(error.code, "checksum_mismatch");
      return true;
    });
  } finally {
    await server.close();
  }
  assert.deepEqual(await files(root, "codex", "1.0.0"), []);
});

test("concurrent requests for one harness share one download", async () => {
  const { server, manager } = await setup();
  try {
    const [first, second] = await Promise.all([
      manager.resolve("codex"),
      manager.resolve("codex"),
    ]);
    assert.equal(first.path, second.path);
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

test("an unsupported platform is reported without a request", async () => {
  const { server, manager } = await setup({}, undefined, { platform: null });
  try {
    await assert.rejects(manager.resolve("codex"), (error: ProgramError) => {
      assert.equal(error.code, "unsupported_platform");
      return true;
    });
    assert.equal(server.requests(), 0);
  } finally {
    await server.close();
  }
  assert.equal(detectPlatform("freebsd", "x64"), null);
  assert.equal(detectPlatform("linux", "x64", true), "linux-x64-musl");
  assert.equal(detectPlatform("linux", "arm64", false), "linux-arm64");
  assert.equal(detectPlatform("win32", "arm64"), "win32-arm64");
});

test("a custom path is used without downloading, and a missing one never downloads", async () => {
  const { server, root, manager } = await setup();
  const custom = join(root, "my-codex");
  await writeFile(custom, "#!/bin/sh\n");
  await chmod(custom, 0o755);
  try {
    const resolved = await manager.resolve("codex", custom);
    assert.deepEqual(resolved, {
      path: custom,
      source: "custom",
      version: null,
    });
    await assert.rejects(
      manager.resolve("codex", join(root, "missing")),
      (error: ProgramError) => {
        assert.equal(error.code, "custom_invalid");
        return true;
      },
    );
    assert.equal(server.requests(), 0);
  } finally {
    await server.close();
  }
});

// A minimal ustar writer for test packages.
function tar(
  entries: { name: string; body?: Buffer; mode?: number; type?: string }[],
) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write(
      `${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`,
      100,
    );
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(" ".repeat(8), 148);
    header.write(entry.type ?? "0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function archiveSetup(
  entries: Parameters<typeof tar>[0],
  executable: Buffer,
) {
  const archive = zstdCompressSync(tar(entries));
  const server = await serve((_path, respond) => respond(200, archive));
  const root = await mkdtemp(join(tmpdir(), "multiplayer-archive-"));
  const manager = new ProgramManager({
    root,
    platform: "darwin-arm64",
    manifest: {
      ...manifest(server.url),
      codex: {
        version: "1.0.0",
        platforms: {
          "darwin-arm64": {
            url: `${server.url}/codex-package.tar.zst`,
            file: "bin/codex",
            download: digest(archive),
            compression: "zstd",
            archive: "tar",
            binary: digest(executable),
          },
        },
      },
    },
  });
  return { server, root, manager };
}

test("a package archive unpacks the executable with its companion files", async () => {
  const helper = Buffer.from("code mode host");
  const { server, root, manager } = await archiveSetup(
    [
      { name: "bin/", type: "5", mode: 0o755 },
      { name: "bin/codex", body: binary, mode: 0o755 },
      { name: "bin/codex-code-mode-host", body: helper, mode: 0o755 },
      { name: "codex-package.json", body: Buffer.from("{}") },
    ],
    binary,
  );
  try {
    const resolved = await manager.resolve("codex");
    assert.equal(
      resolved.path,
      join(root, "harnesses", "codex", "1.0.0", "bin", "codex"),
    );
    assert.deepEqual(await readFile(resolved.path), binary);
    const companion = join(
      root,
      "harnesses",
      "codex",
      "1.0.0",
      "bin",
      "codex-code-mode-host",
    );
    assert.deepEqual(await readFile(companion), helper);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      assert.ok((await stat(companion)).mode & 0o100);
    }
    assert.equal(await manager.installed("codex"), true);
    assert.deepEqual((await readdir(join(root, "harnesses", "codex"))).sort(), [
      "1.0.0",
    ]);
  } finally {
    await server.close();
  }
});

test("a package that writes outside its folder or lacks the pinned executable is refused", async () => {
  for (const entries of [
    [{ name: "../escape", body: Buffer.from("x") }],
    [
      {
        name: "bin/codex",
        body: Buffer.from("not the pinned binary"),
        mode: 0o755,
      },
    ],
    [{ name: "bin/link", type: "2" }],
  ]) {
    const { server, root, manager } = await archiveSetup(entries, binary);
    try {
      await assert.rejects(manager.resolve("codex"), (error: ProgramError) => {
        assert.equal(error.code, "checksum_mismatch");
        return true;
      });
      assert.equal(existsSync(join(root, "harnesses", "escape")), false);
      assert.deepEqual(await readdir(join(root, "harnesses", "codex")), []);
    } finally {
      await server.close();
    }
  }
});
