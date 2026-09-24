// A loopback download server and manifest for E2E runs, so managed harness downloads exercise the
// real download, checksum, and unpack path without the network. The served bytes are placeholders:
// E2E runs launch the harness fixtures instead of the downloaded files.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";

const digest = (buffer) => ({
  sha256: createHash("sha256").update(buffer).digest("hex"),
  size: buffer.length,
});

function platformKey() {
  const arch = process.arch;
  if (process.platform !== "linux") return `${process.platform}-${arch}`;
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
  return glibc ? `linux-${arch}` : `linux-${arch}-musl`;
}

export async function startProgramServer(manifestPath) {
  const codex = Buffer.from("fixture codex program\n".repeat(4096));
  const claude = Buffer.from("fixture claude program\n".repeat(4096));
  const bodies = { codex: zstdCompressSync(codex), claude };
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
  const windows = process.platform === "win32";
  await writeFile(
    manifestPath,
    JSON.stringify({
      codex: {
        version: "0.155.1",
        platforms: {
          [platform]: {
            url: `${url}/codex`,
            file: windows ? "codex.exe" : "codex",
            download: digest(bodies.codex),
            compression: "zstd",
            binary: digest(codex),
          },
        },
      },
      claude: {
        version: "2.1.280",
        platforms: {
          [platform]: {
            url: `${url}/claude`,
            file: windows ? "claude.exe" : "claude",
            download: digest(claude),
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
