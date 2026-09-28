import { schemaDatabase } from "@multiplayer-ai/db/testing";
import { databasePool } from "@multiplayer-ai/api/testing";

export const alice = "11111111-1111-4111-8111-111111111111";
export const bob = "22222222-2222-4222-8222-222222222222";
export const eve = "33333333-3333-4333-8333-333333333333";

export async function sharedDatabase() {
  const db = await schemaDatabase();
  await db.exec(`
    insert into auth.users values ('${alice}', 'alice@example.invalid', '{"name":"Alice"}'), ('${bob}', 'bob@example.invalid', '{"name":"Bob"}'), ('${eve}', 'eve@example.invalid', '{"name":"Eve"}');
  `);
  let queue = Promise.resolve();
  const pool = databasePool(db);
  const rpc = (userId, command, role = "authenticated") => {
    const work = queue.then(async () => {
      const lease = await pool.connect();
      try {
        await db.query(
          "select set_config('request.jwt.claim.sub', $1, false)",
          [userId ?? ""],
        );
        await db.exec(`set role ${role === "anon" ? "anon" : "authenticated"}`);
        try {
          const result =
            command?.type === "suggestion.save-generated"
              ? await db.query(
                  "select public.desktop_save_generated_suggestions($1::uuid, $2::uuid[], $3::text[]) as data",
                  [command.roomId, command.messageIds, command.prompts],
                )
              : command
                ? await db.query(
                    "select public.desktop_room_command($1::jsonb) as data",
                    [JSON.stringify(command)],
                  )
                : await db.query(
                    "select public.desktop_room_snapshot() as data",
                  );
          return result.rows[0].data;
        } finally {
          await db.exec("reset role");
        }
      } finally {
        lease.release();
      }
    });
    queue = work.catch(() => {});
    return work;
  };
  // Calls a public RPC by name with PostgREST-style named JSON arguments, cast by the function's signature.
  const call = (userId, name, args = {}) => {
    const work = queue.then(async () => {
      const lease = await pool.connect();
      try {
        const signature = await db.query(
          "select unnest(p.proargnames) as arg, unnest(p.proargtypes::regtype[])::text as type from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
          [name],
        );
        if (!signature.rows.length) throw new Error("Unknown RPC " + name);
        const params = signature.rows
          .filter(({ arg }) => arg in args)
          .map(({ arg, type }) => {
            const value = `($1::jsonb -> '${arg}')`;
            if (type === "jsonb") return `${arg} => ${value}`;
            if (type.endsWith("[]"))
              return `${arg} => array(select jsonb_array_elements_text(${value}))::${type}`;
            return `${arg} => (${value} #>> '{}')::${type}`;
          });
        await db.query(
          "select set_config('request.jwt.claim.sub', $1, false)",
          [userId ?? ""],
        );
        await db.exec("set role authenticated");
        try {
          const result = await db.query(
            `select public.${name}(${params.join(", ")}) as data`,
            [JSON.stringify(args)],
          );
          return result.rows[0].data;
        } finally {
          await db.exec("reset role");
        }
      } finally {
        lease.release();
      }
    });
    queue = work.catch(() => {});
    return work;
  };
  return { db, pool, rpc, call };
}
