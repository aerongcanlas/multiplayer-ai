import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const roomParams = z.strictObject({ roomId: z.uuid() });
const editParams = roomParams.extend({ suggestionId: z.uuid() });
const roomBody = z.strictObject({ name: z.string().trim().min(1).max(80) });
const messageBody = z.strictObject({
  text: z.string().trim().min(1).max(2000),
});
const inviteBody = z.strictObject({
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{43}$/),
});
const suggestionsBody = z.strictObject({
  messageIds: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
  prompts: z.array(z.string().trim().min(1).max(2000)).min(1).max(3),
});
const editBody = z.strictObject({
  prompt: z.string().trim().min(1).max(8000),
  expectedRevision: z.number().int().positive().max(2147483646),
});
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

// One statement gives every room a consistent view of membership and content.
async function snapshot(db: Pick<PoolClient, "query">, actor: string) {
  const { rows } = await db.query<{ snapshot: unknown }>(
    `
    select jsonb_build_object('version', 1, 'userId', $1::uuid, 'now', now(),
      'rooms', coalesce(jsonb_agg(room_data order by visited desc, room_id), '[]'::jsonb)) as snapshot
    from (
      select r.id as room_id, mine.last_visited_at as visited,
        jsonb_build_object(
          'id', r.id, 'name', r.name, 'slug', r.slug, 'createdAt', r.created_at,
          'isAdmin', mine.is_admin,
          'members', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name, p.id)
            from public.room_member rm join public.user_profile p on p.id = rm.member_id where rm.room_id = r.id), '[]'::jsonb),
          'messages', coalesce((select jsonb_agg(jsonb_build_object(
              'id', m.id, 'authorId', m.author_id, 'authorName', p.name, 'text', m.text, 'createdAt', m.created_at
            ) order by m.created_at, m.id)
            from (select * from public.message where room_id = r.id order by created_at desc, id desc limit 200) m
            join public.user_profile p on p.id = m.author_id), '[]'::jsonb),
          'suggestions', coalesce((select jsonb_agg(jsonb_build_object(
              'id', s.id, 'authorId', s.author_id, 'prompt', s.prompt, 'contextVersion', 0,
              'sourceMessageIds', s.source_message_ids, 'sources', s.sources, 'revision', s.revision,
              'status', 'draft', 'createdAt', s.created_at, 'updatedAt', s.updated_at
            ) order by s.created_at, s.id)
            from (select * from public.desktop_prompt_suggestion where room_id = r.id order by created_at desc, id desc limit 50) s), '[]'::jsonb),
          'sharedTabs', coalesce((select jsonb_agg(jsonb_build_object(
              'tabId', t.tab_id, 'roomId', t.room_id, 'hostId', t.host_id, 'hostName', p.name,
              'deviceId', t.device_id, 'title', t.title, 'harness', t.harness, 'model', t.model,
              'status', t.status, 'switchOn', t.switch_on, 'rev', t.rev, 'updatedAt', t.updated_at
            ) order by t.created_at, t.tab_id)
            from public.desktop_tab_share t
            join public.room_member host on host.room_id = t.room_id and host.member_id = t.host_id
            join public.user_profile p on p.id = t.host_id
            where t.room_id = r.id and t.status <> 'closed'), '[]'::jsonb)
        ) as room_data
      from public.room_member mine join public.room r on r.id = mine.room_id
      where mine.member_id = $1::uuid
    ) rooms`,
    [actor],
  );
  return rows[0].snapshot;
}

async function member(db: PoolClient, actor: string, roomId: string) {
  // Hold membership until commit so revocation cannot race an authorized write.
  const { rows } = await db.query<{ is_admin: boolean }>(
    "select is_admin from public.room_member where room_id = $1 and member_id = $2 for share",
    [roomId, actor],
  );
  if (!rows[0])
    throw new ApiError(
      403,
      "forbidden",
      "You are no longer a member of this room.",
    );
  return rows[0];
}

async function mutate(
  pool: Pool,
  actor: string,
  work: (db: PoolClient) => Promise<{ roomId: string; token?: string }>,
) {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query("begin");
    await db.query(
      `
      insert into public.user_profile(id, name)
        select id, left(coalesce(nullif(raw_user_meta_data->>'preferred_username', ''),
          nullif(raw_user_meta_data->>'user_name', ''), nullif(raw_user_meta_data->>'name', ''), 'User'), 100)
        from auth.users where id = $1 on conflict(id) do nothing`,
      [actor],
    );
    const result = await work(db);
    const data = await snapshot(db, actor);
    await db.query("commit");
    return { ...result, snapshot: data };
  } catch (error) {
    try {
      await db.query("rollback");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

export function registerRooms(app: FastifyInstance, pool: Pool) {
  app.get("/v1/rooms/snapshot", (request) => snapshot(pool, request.actor));

  app.post("/v1/rooms", async (request, reply) => {
    const { name } = roomBody.parse(request.body);
    const result = await mutate(pool, request.actor, async (db) => {
      const roomId = randomUUID();
      const slug =
        (name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "room") +
        "-" +
        roomId.slice(0, 8);
      await db.query(
        "insert into public.room(id, name, slug) values($1, $2, $3)",
        [roomId, name, slug],
      );
      await db.query(
        "insert into public.room_member(room_id, member_id, is_admin) values($1, $2, true)",
        [roomId, request.actor],
      );
      return { roomId };
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/rooms/:roomId/invites", async (request, reply) => {
    const { roomId } = roomParams.parse(request.params);
    z.strictObject({}).parse(request.body ?? {});
    const result = await mutate(pool, request.actor, async (db) => {
      const membership = await member(db, request.actor, roomId);
      if (!membership.is_admin)
        throw new ApiError(
          403,
          "forbidden",
          "Only room admins can create invitations.",
        );
      const token = randomBytes(32).toString("base64url");
      await db.query(
        `insert into public.room_invite(room_id, created_by, token_hash, expires_at)
        values($1, $2, $3, now() + interval '24 hours')`,
        [roomId, request.actor, hash(token)],
      );
      return { roomId, token };
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/invites/accept", async (request) => {
    const { token } = inviteBody.parse(request.body);
    return mutate(pool, request.actor, async (db) => {
      const { rows } = await db.query<{
        id: string;
        room_id: string;
        invalid: boolean;
        accepted_at: Date | null;
        accepted_by: string | null;
        invited_email: string | null;
      }>(
        `select id, room_id, accepted_at, accepted_by, invited_email,
          revoked_at is not null or expires_at <= now() as invalid
        from public.room_invite where token_hash = $1 for update`,
        [hash(token)],
      );
      const invite = rows[0];
      if (!invite || invite.invalid)
        throw new ApiError(
          400,
          "invalid_invite",
          "Invitation is invalid, expired, or revoked.",
        );
      if (invite.accepted_at) {
        if (invite.accepted_by !== request.actor)
          throw new ApiError(
            409,
            "invite_used",
            "This invitation has already been used.",
          );
        await member(db, request.actor, invite.room_id);
        return { roomId: invite.room_id };
      }
      if (invite.invited_email !== null) {
        const user = await db.query(
          "select 1 from auth.users where id = $1 and lower(email) = lower($2)",
          [request.actor, invite.invited_email],
        );
        if (!user.rowCount)
          throw new ApiError(
            403,
            "forbidden",
            "This invitation belongs to another email address.",
          );
      }
      await db.query(
        `insert into public.room_member(room_id, member_id, is_admin) values($1, $2, false)
        on conflict(room_id, member_id) do nothing`,
        [invite.room_id, request.actor],
      );
      await member(db, request.actor, invite.room_id);
      await db.query(
        "update public.room_invite set accepted_at = now(), accepted_by = $1 where id = $2",
        [request.actor, invite.id],
      );
      return { roomId: invite.room_id };
    });
  });

  app.post("/v1/rooms/:roomId/messages", async (request, reply) => {
    const { roomId } = roomParams.parse(request.params);
    const { text } = messageBody.parse(request.body);
    const result = await mutate(pool, request.actor, async (db) => {
      await member(db, request.actor, roomId);
      await db.query(
        "insert into public.message(room_id, author_id, text) values($1, $2, $3)",
        [roomId, request.actor, text],
      );
      return { roomId };
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/rooms/:roomId/suggestions", async (request, reply) => {
    const { roomId } = roomParams.parse(request.params);
    const { messageIds, prompts } = suggestionsBody.parse(request.body);
    const result = await mutate(pool, request.actor, async (db) => {
      await member(db, request.actor, roomId);
      const { rows } = await db.query<{ sources: unknown[] | null }>(
        `
        select jsonb_agg(jsonb_build_object('id', m.id, 'authorId', m.author_id, 'authorName', p.name,
          'text', m.text, 'createdAt', m.created_at) order by m.created_at, m.id) as sources
        from public.message m join public.user_profile p on p.id = m.author_id
        where m.room_id = $1 and m.id = any($2::uuid[])`,
        [roomId, messageIds],
      );
      const sources = rows[0].sources;
      if (sources?.length !== messageIds.length)
        throw new ApiError(
          403,
          "forbidden",
          "A selected message does not belong to this room.",
        );
      for (const prompt of prompts)
        await db.query(
          `insert into public.desktop_prompt_suggestion(room_id, author_id, prompt, source_message_ids, sources)
          values($1, $2, $3, $4::uuid[], $5::jsonb)`,
          [roomId, request.actor, prompt, messageIds, JSON.stringify(sources)],
        );
      return { roomId };
    });
    return reply.code(201).send(result);
  });

  app.patch("/v1/rooms/:roomId/suggestions/:suggestionId", async (request) => {
    const { roomId, suggestionId } = editParams.parse(request.params);
    const { prompt, expectedRevision } = editBody.parse(request.body);
    return mutate(pool, request.actor, async (db) => {
      const membership = await member(db, request.actor, roomId);
      const { rows } = await db.query<{ author_id: string; revision: number }>(
        "select author_id, revision from public.desktop_prompt_suggestion where id = $1 and room_id = $2 for update",
        [suggestionId, roomId],
      );
      const suggestion = rows[0];
      if (!suggestion)
        throw new ApiError(
          404,
          "not_found",
          "Suggestion not found in this room.",
        );
      if (suggestion.author_id !== request.actor && !membership.is_admin)
        throw new ApiError(
          403,
          "forbidden",
          "Only the author or a room admin can edit this suggestion.",
        );
      if (suggestion.revision !== expectedRevision)
        throw new ApiError(
          409,
          "revision_conflict",
          "This suggestion changed. Refresh before editing.",
        );
      await db.query(
        "update public.desktop_prompt_suggestion set prompt = $1, revision = revision + 1, updated_at = now() where id = $2",
        [prompt, suggestionId],
      );
      return { roomId };
    });
  });
}
