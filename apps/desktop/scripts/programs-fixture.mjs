// A loopback download server and manifest for E2E runs, so managed harness downloads exercise the
// real download, checksum, and unpack path without the network. The served bytes are placeholders:
// E2E runs launch the harness fixtures instead of the downloaded files.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { gzipSync, zstdCompressSync } from "node:zlib";

const digest = (buffer) => ({
  sha256: createHash("sha256").update(buffer).digest("hex"),
  size: buffer.length,
});

// A minimal ustar archive shaped like a codex-package release asset.
function tar(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000755\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function platformKey() {
  const arch = process.arch;
  if (process.platform !== "linux") return `${process.platform}-${arch}`;
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
  return glibc ? `linux-${arch}` : `linux-${arch}-musl`;
}

export async function startProgramServer(manifestPath) {
  const codex = Buffer.from("fixture codex program\n".repeat(4096));
  const claude = Buffer.from("fixture claude program\n".repeat(4096));
  const opencode = Buffer.from("fixture opencode program\n".repeat(4096));
  const windows = process.platform === "win32";
  const executable = windows ? "bin/codex.exe" : "bin/codex";
  const opencodeFile = windows
    ? "package/bin/opencode.exe"
    : "package/bin/opencode";
  const bodies = {
    codex: zstdCompressSync(
      tar([
        [executable, codex],
        ["bin/codex-code-mode-host", Buffer.from("fixture companion\n")],
      ]),
    ),
    claude,
    // An npm platform package, shaped like opencode-<platform>.
    opencode: gzipSync(
      tar([
        ["package/package.json", Buffer.from("{}")],
        [opencodeFile, opencode],
      ]),
    ),
  };
  const corrupt = new Set();
  const requests = [];
  const server = createServer((request, response) => {
    const harness = request.url?.slice(1);
    requests.push(harness);
    const body = bodies[harness];
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    // A corrupted asset keeps its length so only the digest check can catch it.
    const served = Buffer.from(body);
    if (corrupt.has(harness)) served[0] ^= 0xff;
    response.writeHead(200, { "content-length": served.length });
    response.end(served);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const platform = platformKey();
  await writeFile(
    manifestPath,
    JSON.stringify({
      codex: {
        version: "0.160.0",
        platforms: {
          [platform]: {
            url: `${url}/codex`,
            file: executable,
            download: digest(bodies.codex),
            compression: "zstd",
            archive: "tar",
            binary: digest(codex),
          },
        },
      },
      claude: {
        version: "2.1.286",
        platforms: {
          [platform]: {
            url: `${url}/claude`,
            file: windows ? "claude.exe" : "claude",
            download: digest(claude),
          },
        },
      },
      opencode: {
        version: "1.18.34",
        platforms: {
          [platform]: {
            url: `${url}/opencode`,
            file: opencodeFile,
            download: digest(bodies.opencode),
            compression: "gzip",
            archive: "tar",
            binary: digest(opencode),
          },
        },
      },
    }),
  );
  return {
    url,
    requests: (harness) => requests.filter((item) => item === harness).length,
    corrupt: (harness, value = true) =>
      value ? corrupt.add(harness) : corrupt.delete(harness),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
