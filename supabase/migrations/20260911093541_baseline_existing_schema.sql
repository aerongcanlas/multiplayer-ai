-- Baseline captured from the linked project on 2026-09-11.
-- This file is the disposable/local starting point. It is not a replay of the
-- linked project's migration history; production cutover must baseline its
-- existing migration state first (KTD8).

create table public.user_profile (
    id uuid primary key references auth.users(id) on update cascade on delete cascade,
    created_at timestamptz not null default now(),
    name varchar not null,
    image_url varchar
);

create table public.room (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    name varchar not null,
    slug varchar not null
);

create table public.room_member (
    created_at timestamptz not null default now(),
    member_id uuid not null references public.user_profile(id) on update cascade on delete cascade,
    room_id uuid not null references public.room(id) on update cascade on delete cascade,
    is_admin boolean not null,
    last_visited_at timestamptz not null default now(),
    primary key (member_id, room_id)
);

create table public.message (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    text text not null,
    room_id uuid not null references public.room(id) on update cascade on delete cascade,
    author_id uuid not null references public.user_profile(id) on update cascade on delete set null
);

create table public.room_invite (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    room_id uuid not null references public.room(id) on update cascade on delete cascade,
    created_by uuid not null references public.user_profile(id) on update cascade on delete cascade,
    invited_email text,
    token_hash text not null unique,
    expires_at timestamptz not null,
    accepted_at timestamptz,
    accepted_by uuid references public.user_profile(id),
    revoked_at timestamptz
);

create or replace function public.accept_room_invite(
    p_token_hash text,
    p_user_id uuid
)
returns table (
    status text,
    accepted_room_id uuid,
    accepted_room_slug text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
    invite public.room_invite%rowtype;
    room_slug text;
begin
    select * into invite
    from public.room_invite
    where token_hash = p_token_hash
    for update;

    if not found
       or invite.accepted_at is not null
       or invite.revoked_at is not null
       or invite.expires_at <= now() then
        return query select 'invalid', null::uuid, null::text;
        return;
    end if;

    insert into public.room_member (room_id, member_id, is_admin)
    values (invite.room_id, p_user_id, false)
    on conflict (member_id, room_id) do nothing;

    update public.room_invite
    set accepted_at = now(), accepted_by = p_user_id
    where id = invite.id;

    select slug into room_slug from public.room where id = invite.room_id;
    return query select 'accepted', invite.room_id, room_slug;
end;
$$;

create table public.desktop_prompt_suggestion (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.room(id) on delete cascade,
    author_id uuid not null references public.user_profile(id),
    prompt text not null check (length(prompt) between 1 and 8000),
    source_message_ids uuid[] not null,
    sources jsonb not null,
    revision integer not null default 1 check (revision > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create sequence public.ai_message_seq_seq as bigint;

create table public.ai_thread (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.room(id) on delete cascade,
    created_at timestamptz not null default now(),
    retired_at timestamptz,
    run_status text not null default 'finished'
        check (run_status in ('running', 'finished', 'failed', 'cancelled')),
    run_started_at timestamptz,
    run_by uuid references public.user_profile(id)
);

create unique index ai_thread_one_active_per_room
    on public.ai_thread (room_id)
    where retired_at is null;

create table public.ai_message (
    id uuid primary key,
    thread_id uuid not null references public.ai_thread(id) on delete cascade,
    seq bigint not null default nextval('public.ai_message_seq_seq'),
    role text not null check (role in ('user', 'assistant', 'system')),
    parts jsonb not null,
    metadata jsonb,
    author_id uuid references public.user_profile(id),
    created_at timestamptz not null default now(),
    unique (thread_id, seq)
);

alter sequence public.ai_message_seq_seq owned by public.ai_message.seq;

-- Existing RLS is intentionally retained. Server entry points use the admin
-- client and U1 functions below additionally re-check membership.
alter table public.user_profile enable row level security;
alter table public.room enable row level security;
alter table public.room_member enable row level security;
alter table public.message enable row level security;
alter table public.room_invite enable row level security;
alter table public.desktop_prompt_suggestion enable row level security;
alter table public.ai_thread enable row level security;
alter table public.ai_message enable row level security;

-- Supabase's service role is the existing server-side data path. The linked
-- catalog has no anon/authenticated table grants or policies for these tables.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function public.accept_room_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.accept_room_invite(text, uuid) to service_role;
