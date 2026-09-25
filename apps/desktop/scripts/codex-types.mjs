// Keeps only the generated Codex protocol types the adapter reaches. Run after
// `codex app-server generate-ts --experimental --out src/supervisor/harnesses/codex/generated`.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const codexDir = resolve(import.meta.dirname, "../src/supervisor/harnesses/codex");
const generated = join(codexDir, "generated");
const importsOf = (file) =>
  [...readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)].map(([, spec]) =>
    normalize(resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`)),
  );
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const keep = new Set();
const queue = walk(codexDir)
  .filter((file) => !file.startsWith(generated) && file.endsWith(".ts"))
  .flatMap(importsOf)
  .filter((file) => file.startsWith(generated));
while (queue.length) {
  const file = queue.pop();
  if (keep.has(file)) continue;
  keep.add(file);
  queue.push(...importsOf(file));
}
let removed = 0;
for (const file of walk(generated))
  if (!keep.has(file)) {
    rmSync(file);
    removed++;
  }
for (const dir of readdirSync(generated, { recursive: true, withFileTypes: true }))
  if (dir.isDirectory() && !readdirSync(join(dir.parentPath, dir.name)).length)
    rmSync(join(dir.parentPath, dir.name), { recursive: true });
console.log(`kept ${keep.size} generated types, removed ${removed}`);
console.log([...keep].map((file) => relative(generated, file)).sort().join("\n"));
