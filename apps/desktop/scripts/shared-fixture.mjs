import { schemaDatabase } from "@multiplayer-ai/db/testing";

export const alice = "11111111-1111-4111-8111-111111111111";
export const bob = "22222222-2222-4222-8222-222222222222";
export const eve = "33333333-3333-4333-8333-333333333333";

export async function sharedDatabase() {
  const db = await schemaDatabase();
  await db.exec(`
    insert into auth.users values ('${alice}', 'alice@example.invalid', '{"name":"Alice"}'), ('${bob}', 'bob@example.invalid', '{"name":"Bob"}'), ('${eve}', 'eve@example.invalid', '{"name":"Eve"}');
  `);
  let queue = Promise.resolve();
  const rpc = (userId, command, role = "authenticated") => {
    const work = queue.then(async () => {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
        userId ?? "",
      ]);
      await db.exec(`set role ${role === "anon" ? "anon" : "authenticated"}`);
      try {
        const result = command
          ? await db.query(
              "select public.desktop_room_command($1::jsonb) as data",
              [JSON.stringify(command)],
            )
          : await db.query("select public.desktop_room_snapshot() as data");
        return result.rows[0].data;
      } finally {
        await db.exec("reset role");
      }
    });
    queue = work.catch(() => {});
    return work;
  };
  return { db, rpc };
}
