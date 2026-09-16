import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { introspect } from "@supabase/postgrest-typegen/introspection";
import {
  generateTypescript,
  sortGeneratorMetadata,
} from "@supabase/postgrest-typegen/generation";
import { schemaDatabase } from "./schema-fixture.mjs";

// Generate from the canonical migrations without a remote database or Docker.
const db = await schemaDatabase();
try {
  const metadata = await introspect(db, { includedSchemas: ["public"] });
  const types = await generateTypescript(sortGeneratorMetadata(metadata), {
    detectOneToOneRelationships: true,
    defaultSchema: "public",
  });
  const output =
    "// Generated from supabase/migrations by pnpm db:types. Do not edit.\n" +
    (await format(types, { parser: "typescript", semi: true }));
  const path = new URL("../src/generated/database.types.ts", import.meta.url);
  if (process.argv.includes("--check")) {
    const existing = await readFile(path, "utf8");
    if (existing.replaceAll("\r\n", "\n") !== output.replaceAll("\r\n", "\n")) {
      throw new Error(
        "Database types are stale. Run pnpm db:types and commit the generated result.",
      );
    }
    console.log("Database types match the canonical migration chain.");
  } else {
    await writeFile(path, output);
    console.log(
      "Generated packages/db/src/generated/database.types.ts from local migrations.",
    );
  }
} finally {
  await db.close();
}
