-- U1: additive, history-preserving fields and transactional thread ownership.
-- The partial one-active-thread index is deliberately retained here. Dropping
-- it is a coordinated U8 cutover operation after old writers are quiesced.

alter table public.ai_thread
    add column title text not null default 'New thread',
    add column title_source text not null default 'default'
        check (title_source in ('default', 'auto', 'manual')),
    add column current_run_id uuid,
    add column creation_id uuid;

alter table public.ai_message
    add column run_id uuid;

-- Existing rows have no durable title. Derive it without changing message
-- identity/content; retired rows remain retired and empty rows stay New thread.
with first_user_message as (
    select distinct on (thread_id)
        thread_id,
        btrim(regexp_replace(
            coalesce((
                select string_agg(coalesce(part->>'text', ''), '')
                from jsonb_array_elements(
                    case when jsonb_typeof(m.parts) = 'array' then m.parts else '[]'::jsonb end
                ) as part
                where part->>'type' = 'text'
            ), ''),
            '\s+', ' ', 'g'
        )) as prompt
    from public.ai_message as m
    where m.role = 'user'
    order by m.thread_id, m.seq
), bounded_titles as (
    select thread_id, left(prompt, 80) as title
    from first_user_message
    where prompt <> ''
)
update public.ai_thread as t
set title = b.title, title_source = 'auto'
from bounded_titles as b
where t.id = b.thread_id;

create index ai_thread_room_archive_created_id
    on public.ai_thread (room_id, retired_at, created_at desc, id desc);

create unique index ai_thread_room_creation_id
    on public.ai_thread (room_id, creation_id)
    where creation_id is not null;

create or replace function public._ai_assert_member(
    p_room_id uuid,
    p_actor_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    if not exists (
        select 1
        from public.room_member as rm
        where rm.room_id = p_room_id and rm.member_id = p_actor_id
    ) then
        raise exception using
            errcode = '42501',
            message = 'actor is not a member of this room';
    end if;
end;
$$;

create or replace function public.create_ai_thread(
    p_room_id uuid,
    p_actor_id uuid,
    p_creation_id uuid default null
)
returns table (
    thread_id uuid,
    room_id uuid,
    created_at timestamptz,
    retired_at timestamptz,
    title text,
    title_source text,
    run_status text,
    current_run_id uuid
)
language plpgsql
security invoker
set search_path = public
as $$
declare
    existing public.ai_thread%rowtype;
begin
    perform public._ai_assert_member(p_room_id, p_actor_id);
    perform set_config('app.ai_thread_mutation', 'fenced', true);

    if p_creation_id is not null then
        select t.* into existing
        from public.ai_thread as t
        where t.creation_id = p_creation_id
        for update;

        if found then
            if existing.room_id <> p_room_id then
                raise exception using
                    errcode = '23505',
                    message = 'creation id belongs to another room';
            end if;
            return query select existing.id, existing.room_id, existing.created_at,
                existing.retired_at, existing.title, existing.title_source,
                existing.run_status, existing.current_run_id;
            return;
        end if;
    end if;

    return query
    insert into public.ai_thread as inserted (room_id, creation_id)
    values (p_room_id, p_creation_id)
    returning inserted.id, inserted.room_id, inserted.created_at,
        inserted.retired_at, inserted.title, inserted.title_source,
        inserted.run_status, inserted.current_run_id;
exception when unique_violation then
    -- A retry racing another request is idempotent. The unique active-thread
    -- index remains in place until U8, so callers get a normal DB conflict if
    -- they attempt this before the coordinated cutover.
    if p_creation_id is not null then
        return query select t.id, t.room_id, t.created_at, t.retired_at,
            t.title, t.title_source, t.run_status, t.current_run_id
        from public.ai_thread as t
        where t.room_id = p_room_id and t.creation_id = p_creation_id;
        if found then return; end if;
    end if;
    raise;
end;
$$;

create or replace function public.claim_ai_thread_run(
    p_room_id uuid,
    p_thread_id uuid,
    p_actor_id uuid,
    p_run_id uuid,
    p_user_message_id uuid,
    p_parts jsonb,
    p_metadata jsonb default null
)
returns table (
    outcome text,
    thread_id uuid,
    run_id uuid,
    accepted_message_seq bigint,
    title text,
    title_source text,
    run_by uuid,
    run_status text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
    t public.ai_thread%rowtype;
    existing_message public.ai_message%rowtype;
    auto_title text;
begin
    perform public._ai_assert_member(p_room_id, p_actor_id);
    perform set_config('app.ai_thread_mutation', 'fenced', true);

    select * into t
    from public.ai_thread
    where id = p_thread_id
    for update;

    if not found or t.room_id <> p_room_id then
        raise exception using errcode = 'P0002', message = 'thread not found';
    end if;

    if t.run_status = 'running'
       and (t.run_started_at is null or t.run_started_at < now() - interval '360 seconds') then
        update public.ai_thread
        set run_status = 'failed', run_started_at = null, run_by = null,
            current_run_id = null
        where id = t.id;
        t.run_status := 'failed';
        t.run_started_at := null;
        t.run_by := null;
        t.current_run_id := null;
    end if;

    select * into existing_message
    from public.ai_message
    where id = p_user_message_id
    for update;

    if found then
        if existing_message.thread_id <> p_thread_id
           or existing_message.role <> 'user' then
            raise exception using
                errcode = '23505',
                message = 'user message id belongs to another thread';
        end if;
        return query select 'already_accepted', t.id, existing_message.run_id,
            existing_message.seq, t.title, t.title_source, t.run_by, t.run_status;
        return;
    end if;

    if t.retired_at is not null then
        raise exception using errcode = 'P0001', message = 'thread is archived';
    end if;
    if t.run_status = 'running' or t.current_run_id is not null then
        raise exception using errcode = '55P03', message = 'thread already has an active run';
    end if;

    insert into public.ai_message (id, thread_id, run_id, role, parts, metadata, author_id)
    values (p_user_message_id, p_thread_id, p_run_id, 'user', p_parts, p_metadata, p_actor_id)
    returning seq into accepted_message_seq;

    auto_title := btrim(regexp_replace(
        coalesce((
            select string_agg(coalesce(part->>'text', ''), '')
            from jsonb_array_elements(
                case when jsonb_typeof(p_parts) = 'array' then p_parts else '[]'::jsonb end
            ) as part
            where part->>'type' = 'text'
        ), ''),
        '\s+', ' ', 'g'
    ));
    auto_title := nullif(left(auto_title, 80), '');

    update public.ai_thread as claimed
    set current_run_id = p_run_id,
        run_status = 'running',
        run_started_at = now(),
        run_by = p_actor_id,
        title = case
            when claimed.title_source = 'default' then coalesce(auto_title, claimed.title)
            else claimed.title
        end,
        title_source = case
            when claimed.title_source = 'default' and auto_title is not null then 'auto'
            else claimed.title_source
        end
    where claimed.id = p_thread_id;

    return query select 'accepted', p_thread_id, p_run_id, accepted_message_seq,
        updated.title, updated.title_source, updated.run_by, updated.run_status
    from public.ai_thread as updated
    where updated.id = p_thread_id;
end;
$$;

create or replace function public.write_ai_thread_message(
    p_room_id uuid,
    p_thread_id uuid,
    p_actor_id uuid,
    p_run_id uuid,
    p_message_id uuid,
    p_role text,
    p_parts jsonb,
    p_metadata jsonb default null,
    p_author_id uuid default null
)
returns table (message_id uuid, seq bigint, outcome text)
language plpgsql
security invoker
set search_path = public
as $$
declare
    t public.ai_thread%rowtype;
    existing public.ai_message%rowtype;
begin
    perform public._ai_assert_member(p_room_id, p_actor_id);
    if p_role not in ('user', 'assistant', 'system') then
        raise exception using errcode = '22023', message = 'invalid AI message role';
    end if;

    select * into t from public.ai_thread where id = p_thread_id for update;
    if not found or t.room_id <> p_room_id then
        raise exception using errcode = 'P0002', message = 'thread not found';
    end if;
    if t.current_run_id is distinct from p_run_id or t.run_status <> 'running' then
        raise exception using errcode = '40001', message = 'stale or inactive run token';
    end if;

    select * into existing from public.ai_message where id = p_message_id for update;
    if found then
        if existing.thread_id <> p_thread_id or existing.run_id is distinct from p_run_id then
            raise exception using errcode = '23505', message = 'message id belongs to another thread or run';
        end if;
        update public.ai_message
        set parts = p_parts, metadata = p_metadata
        where id = p_message_id;
        return query select p_message_id, existing.seq, 'updated';
        return;
    end if;

    insert into public.ai_message (id, thread_id, run_id, role, parts, metadata, author_id)
    values (p_message_id, p_thread_id, p_run_id, p_role, p_parts, p_metadata, p_author_id)
    returning id, ai_message.seq into write_ai_thread_message.message_id, write_ai_thread_message.seq;
    outcome := 'inserted';
    return next;
end;
$$;

create or replace function public.finalize_ai_thread_run(
    p_room_id uuid,
    p_thread_id uuid,
    p_actor_id uuid,
    p_run_id uuid,
    p_status text
)
returns table (outcome text, thread_id uuid, run_id uuid, run_status text)
language plpgsql
security invoker
set search_path = public
as $$
declare
    t public.ai_thread%rowtype;
begin
    perform public._ai_assert_member(p_room_id, p_actor_id);
    perform set_config('app.ai_thread_mutation', 'fenced', true);
    if p_status not in ('finished', 'failed', 'cancelled') then
        raise exception using errcode = '22023', message = 'invalid terminal run status';
    end if;
    select * into t from public.ai_thread where id = p_thread_id for update;
    if not found or t.room_id <> p_room_id then
        raise exception using errcode = 'P0002', message = 'thread not found';
    end if;
    if t.current_run_id is distinct from p_run_id or t.run_status <> 'running' then
        return query select 'stale', t.id, p_run_id, t.run_status;
        return;
    end if;
    update public.ai_thread
    set run_status = p_status, run_started_at = null, run_by = null, current_run_id = null
    where id = p_thread_id;
    return query select 'finalized', t.id, p_run_id, p_status;
end;
$$;

create or replace function public.archive_ai_thread(
    p_room_id uuid,
    p_thread_id uuid,
    p_actor_id uuid
)
returns table (outcome text, thread_id uuid, retired_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
    t public.ai_thread%rowtype;
    archived_at timestamptz;
begin
    perform public._ai_assert_member(p_room_id, p_actor_id);
    perform set_config('app.ai_thread_mutation', 'fenced', true);
    select * into t from public.ai_thread where id = p_thread_id for update;
    if not found or t.room_id <> p_room_id then
        raise exception using errcode = 'P0002', message = 'thread not found';
    end if;
    if t.run_status = 'running'
       and (t.run_started_at is null or t.run_started_at < now() - interval '360 seconds') then
        update public.ai_thread set run_status = 'failed', run_started_at = null,
            run_by = null, current_run_id = null where id = p_thread_id;
        t.run_status := 'failed';
    end if;
    if t.run_status = 'running' or t.current_run_id is not null then
        raise exception using errcode = '55P03', message = 'running thread cannot be archived';
    end if;
    if t.retired_at is not null then
        return query select 'already_archived', t.id, t.retired_at;
        return;
    end if;
    update public.ai_thread set retired_at = now()
    where id = p_thread_id returning public.ai_thread.retired_at into archived_at;
    return query select 'archived', p_thread_id, archived_at;
end;
$$;

create or replace function public.restore_ai_thread(
    p_room_id uuid,
    p_thread_id uuid,
    p_actor_id uuid
)
returns table (outcome text, thread_id uuid, retired_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
    t public.ai_thread%rowtype;
begin
    perform public._ai_assert_member(p_room_id, p_actor_id);
    perform set_config('app.ai_thread_mutation', 'fenced', true);
    select * into t from public.ai_thread where id = p_thread_id for update;
    if not found or t.room_id <> p_room_id then
        raise exception using errcode = 'P0002', message = 'thread not found';
    end if;
    if t.current_run_id is not null or t.run_status = 'running' then
        raise exception using errcode = '55P03', message = 'running thread cannot be restored';
    end if;
    if t.retired_at is null then
        return query select 'already_restored', t.id, null::timestamptz;
        return;
    end if;
    update public.ai_thread set retired_at = null where id = p_thread_id;
    return query select 'restored', p_thread_id, null::timestamptz;
end;
$$;

create or replace function public.rename_ai_thread(
    p_room_id uuid,
    p_thread_id uuid,
    p_actor_id uuid,
    p_title text
)
returns table (thread_id uuid, title text, title_source text)
language plpgsql
security invoker
set search_path = public
as $$
declare
    normalized text := btrim(p_title);
begin
    perform public._ai_assert_member(p_room_id, p_actor_id);
    perform set_config('app.ai_thread_mutation', 'fenced', true);
    if normalized = '' or char_length(normalized) > 80 then
        raise exception using errcode = '22023', message = 'thread title must be 1 to 80 characters';
    end if;
    update public.ai_thread
    set title = normalized, title_source = 'manual'
    where id = p_thread_id and room_id = p_room_id
    returning id, public.ai_thread.title, public.ai_thread.title_source
    into rename_ai_thread.thread_id, rename_ai_thread.title, rename_ai_thread.title_source;
    if not found then
        raise exception using errcode = 'P0002', message = 'thread not found';
    end if;
    return next;
end;
$$;

-- PostgREST exposes functions to PUBLIC by default. U1 mutations are a
-- service-only boundary; keep direct table access/RLS unchanged as well.
revoke execute on function public._ai_assert_member(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.create_ai_thread(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.claim_ai_thread_run(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.write_ai_thread_message(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.finalize_ai_thread_run(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.archive_ai_thread(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.restore_ai_thread(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rename_ai_thread(uuid, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.create_ai_thread(uuid, uuid, uuid) to service_role;
grant execute on function public._ai_assert_member(uuid, uuid) to service_role;
grant execute on function public.claim_ai_thread_run(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.write_ai_thread_message(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, uuid) to service_role;
grant execute on function public.finalize_ai_thread_run(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.archive_ai_thread(uuid, uuid, uuid) to service_role;
grant execute on function public.restore_ai_thread(uuid, uuid, uuid) to service_role;
grant execute on function public.rename_ai_thread(uuid, uuid, uuid, text) to service_role;
