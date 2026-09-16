import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";

// Only the Supabase platform roles/auth schema are stubbed. Application tables,
// constraints and functions always come from the repository's migration chain.
export async function schemaDatabase() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
    `);
    const directory = new URL("../../../supabase/migrations/", import.meta.url);
    const migrations = (await readdir(directory))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      await db.exec(await readFile(new URL(migration, directory), "utf8"));
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
