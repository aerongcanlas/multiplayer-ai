-- Read-along: a host desktop publishes masked, shareable entries of a harness chat tab to its
-- shared room, and members pull them. Rows are the truth; there is no Realtime channel.
-- Only the tab's host device writes its rows, and clients reach the tables only through the RPCs.
begin;

create table if not exists public.desktop_tab_share (
  tab_id uuid primary key,
  room_id uuid not null references public.room(id) on delete cascade,
  host_id uuid not null references public.user_profile(id) on delete cascade,
  device_id text not null,
  title text not null,
  harness text not null check (harness in ('codex', 'claude')),
  model text not null,
  status text not null check (status in ('running', 'awaiting_host', 'idle', 'interrupted', 'ended', 'closed')),
  switch_on boolean not null,
  rev bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists desktop_tab_share_room_idx on public.desktop_tab_share(room_id, host_id);

create table if not exists public.desktop_tab_share_entry (
  tab_id uuid not null references public.desktop_tab_share(tab_id) on delete cascade,
  seq integer not null,
  kind text not null,
  share text not null,
  state text,
  body jsonb not null,
  version integer not null,
  rev bigint not null,
  updated_at timestamptz not null default now(),
  primary key (tab_id, seq)
);
create index if not exists desktop_tab_share_entry_rev_idx on public.desktop_tab_share_entry(tab_id, rev, seq);

alter table public.desktop_tab_share enable row level security;
alter table public.desktop_tab_share_entry enable row level security;
revoke all on public.desktop_tab_share from public, anon, authenticated;
revoke all on public.desktop_tab_share_entry from public, anon, authenticated;

-- The record fields a viewer sees, shared by the snapshot and the pull.
create or replace function public.desktop_tab_share_json(t public.desktop_tab_share)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'tabId', t.tab_id, 'roomId', t.room_id, 'hostId', t.host_id,
    'hostName', (select p.name from public.user_profile p where p.id = t.host_id),
    'deviceId', t.device_id, 'title', t.title, 'harness', t.harness, 'model', t.model,
    'status', t.status, 'switchOn', t.switch_on, 'rev', t.rev, 'updatedAt', t.updated_at);
$$;

create or replace function public.desktop_tab_share_publish(p_tab jsonb, p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  target uuid;
  tab uuid;
  device text := p_tab->>'deviceId';
  entries jsonb := coalesce(p_entries, '[]'::jsonb);
  entry jsonb;
  shared public.desktop_tab_share%rowtype;
  next_rev bigint;
  head_seq integer;
  head_version integer;
begin
  if actor is null then raise exception 'Sign in to access shared rooms.' using errcode = '42501'; end if;
  if jsonb_typeof(p_tab) is distinct from 'object' then
    raise exception 'A shared tab needs a record.' using errcode = '22023';
  end if;
  begin
    tab := (p_tab->>'tabId')::uuid;
    target := (p_tab->>'roomId')::uuid;
  exception when others then
    raise exception 'A shared tab needs a tab and a room.' using errcode = '22023';
  end;
  -- Every check is coalesced: a missing or mistyped field must fail, never yield NULL.
  if tab is null or target is null
    or not coalesce(device ~ '^[A-Za-z0-9_-]{8,64}$', false)
    or not coalesce(jsonb_typeof(p_tab->'title') = 'string' and length(p_tab->>'title') between 1 and 80, false)
    or not coalesce(p_tab->>'harness' in ('codex', 'claude'), false)
    or not coalesce(jsonb_typeof(p_tab->'model') = 'string' and length(p_tab->>'model') <= 120, false)
    or not coalesce(p_tab->>'status' in ('running', 'awaiting_host', 'idle', 'interrupted', 'ended', 'closed'), false)
    or not coalesce(jsonb_typeof(p_tab->'switchOn') = 'boolean', false) then
    raise exception 'The shared tab record is invalid.' using errcode = '22023';
  end if;
  if jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) > 200 then
    raise exception 'Publish at most 200 entries at a time.' using errcode = '22023';
  end if;
  for entry in select value from jsonb_array_elements(entries) loop
    if jsonb_typeof(entry) <> 'object'
      or exists (select 1 from jsonb_object_keys(entry) k
        where k <> all (array['seq', 'kind', 'share', 'state', 'outcome', 'notice', 'summary', 'text', 'detail', 'version']))
      or not coalesce(jsonb_typeof(entry->'seq') = 'number' and entry->>'seq' ~ '^[1-9][0-9]{0,8}$', false)
      or not coalesce(jsonb_typeof(entry->'version') = 'number' and entry->>'version' ~ '^[1-9][0-9]{0,8}$', false)
      or not coalesce(entry->>'kind' in ('user', 'assistant', 'plan', 'tool', 'approval', 'notice', 'error', 'turn'), false)
      or not coalesce(entry->>'share' in ('full', 'summary'), false)
      or not coalesce(jsonb_typeof(entry->'summary') = 'string' and length(entry->>'summary') <= 400, false)
      or (entry ? 'state' and not coalesce(entry->>'state' in ('pending', 'accepted', 'declined', 'answered', 'cancelled'), false))
      or (entry ? 'outcome' and not coalesce(entry->>'outcome' in ('completed', 'stopped', 'failed', 'interrupted'), false))
      or (entry ? 'notice' and not coalesce(jsonb_typeof(entry->'notice') = 'string' and entry->>'notice' ~ '^[a-z_]{1,40}$', false))
      or (entry ? 'text' and not coalesce(jsonb_typeof(entry->'text') = 'string' and length(entry->>'text') <= 200000, false))
      or (entry ? 'detail' and not coalesce(entry->>'kind' = 'plan' and jsonb_typeof(entry->'detail') = 'string'
        and octet_length(entry->>'detail') <= 65536, false)) then
      raise exception 'A shared entry is invalid.' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct value->>'seq') from jsonb_array_elements(entries)) <> jsonb_array_length(entries) then
    raise exception 'Shared entries must have distinct sequences.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.room_member where room_id = target and member_id = actor) then
    raise exception 'You are no longer a member of this room.' using errcode = '42501';
  end if;

  insert into public.desktop_tab_share(tab_id, room_id, host_id, device_id, title, harness, model, status, switch_on)
    values (tab, target, actor, device, p_tab->>'title', p_tab->>'harness', p_tab->>'model', p_tab->>'status',
      (p_tab->>'switchOn')::boolean)
    on conflict (tab_id) do nothing;
  -- The first writer owns the tab for good; any other account or device is refused.
  select * into shared from public.desktop_tab_share
    where tab_id = tab and host_id = actor and device_id = device for update;
  if not found then raise exception 'Only the host device can publish this tab.' using errcode = '42501'; end if;
  if shared.room_id <> target then
    raise exception 'A shared tab cannot move between rooms.' using errcode = '22023';
  end if;
  -- The lock serializes publishes per tab, so rev is gap-free and monotonic.
  next_rev := shared.rev + 1;
  update public.desktop_tab_share set title = p_tab->>'title', harness = p_tab->>'harness', model = p_tab->>'model',
    status = p_tab->>'status', switch_on = (p_tab->>'switchOn')::boolean, rev = next_rev, updated_at = now()
    where tab_id = tab;
  insert into public.desktop_tab_share_entry(tab_id, seq, kind, share, state, body, version, rev)
    select tab, (value->>'seq')::integer, value->>'kind', value->>'share', value->>'state', value,
      (value->>'version')::integer, next_rev
    from jsonb_array_elements(entries)
    on conflict (tab_id, seq) do update
      set kind = excluded.kind, share = excluded.share, state = excluded.state, body = excluded.body,
        version = excluded.version, rev = next_rev, updated_at = now()
      where public.desktop_tab_share_entry.version < excluded.version;
  select e.seq, e.version into head_seq, head_version from public.desktop_tab_share_entry e
    where e.tab_id = tab order by e.seq desc limit 1;
  return jsonb_build_object('maxSeq', head_seq, 'version', head_version, 'rev', next_rev);
end;
$$;

-- The caller's own watermark: the newest entry and every approval still stored as pending.
create or replace function public.desktop_tab_share_head(p_tab_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  shared public.desktop_tab_share%rowtype;
  head_seq integer;
  head_version integer;
begin
  if actor is null then raise exception 'Sign in to access shared rooms.' using errcode = '42501'; end if;
  select * into shared from public.desktop_tab_share where tab_id = p_tab_id;
  if not found then return null; end if;
  if shared.host_id <> actor
    or not exists (select 1 from public.room_member where room_id = shared.room_id and member_id = actor) then
    raise exception 'You are no longer a member of this room.' using errcode = '42501';
  end if;
  select e.seq, e.version into head_seq, head_version from public.desktop_tab_share_entry e
    where e.tab_id = p_tab_id order by e.seq desc limit 1;
  return jsonb_build_object('maxSeq', head_seq, 'version', head_version, 'rev', shared.rev,
    'pending', coalesce((select jsonb_agg(jsonb_build_object('seq', e.seq, 'version', e.version) order by e.seq)
      from public.desktop_tab_share_entry e where e.tab_id = p_tab_id and e.state = 'pending'), '[]'::jsonb));
end;
$$;

-- Delta mode (after_rev given): rows past the (rev, seq) cursor in cursor order. History mode:
-- the newest rows below before_seq. A page stops at the byte budget and returns next when rows remain.
create or replace function public.desktop_tab_share_pull(p_tab_id uuid, p_after_rev bigint, p_after_seq integer,
  p_before_seq integer, p_limit integer, p_byte_budget integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  shared public.desktop_tab_share%rowtype;
  page_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
  budget integer := least(greatest(coalesce(p_byte_budget, 1048576), 1024), 4194304);
  used integer := 0;
  size integer;
  row_count integer := 0;
  result jsonb := '[]'::jsonb;
  next_cursor jsonb;
  last_row record;
  item record;
begin
  if actor is null then raise exception 'Sign in to access shared rooms.' using errcode = '42501'; end if;
  if coalesce(p_after_rev, 0) < 0 or coalesce(p_after_seq, 0) < 0 or coalesce(p_before_seq, 0) < 0 then
    raise exception 'Cursors cannot be negative.' using errcode = '22023';
  end if;
  -- The record is read before the entries, so its rev never exceeds what the viewer receives.
  select * into shared from public.desktop_tab_share where tab_id = p_tab_id;
  if not found or not exists (select 1 from public.room_member where room_id = shared.room_id and member_id = actor) then
    raise exception 'This tab is not shared with you.' using errcode = '42501';
  end if;
  for item in
    select e.seq, e.rev, e.body || jsonb_build_object('rev', e.rev, 'updatedAt', e.updated_at) as data
    from public.desktop_tab_share_entry e
    where e.tab_id = p_tab_id and (p_after_rev is null or (e.rev, e.seq) > (p_after_rev, coalesce(p_after_seq, 0)))
      and (p_after_rev is not null or p_before_seq is null or e.seq < p_before_seq)
    order by case when p_after_rev is null then -e.seq end, e.rev, e.seq
    limit page_limit + 1
  loop
    size := octet_length(item.data::text);
    if row_count = page_limit or (row_count > 0 and used + size > budget) then
      next_cursor := jsonb_build_object('rev', last_row.rev, 'seq', last_row.seq);
      exit;
    end if;
    result := result || jsonb_build_array(item.data);
    used := used + size;
    row_count := row_count + 1;
    last_row := item;
  end loop;
  return jsonb_build_object('record', public.desktop_tab_share_json(shared), 'entries', result,
    'next', next_cursor, 'now', now());
end;
$$;

-- Closes the caller's rows for one device whose tabs are no longer live on it.
create or replace function public.desktop_tab_share_reconcile(p_device_id text, p_live_tab_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to access shared rooms.' using errcode = '42501'; end if;
  if not coalesce(p_device_id ~ '^[A-Za-z0-9_-]{8,64}$', false) or coalesce(cardinality(p_live_tab_ids), 0) > 500 then
    raise exception 'The reconcile request is invalid.' using errcode = '22023';
  end if;
  update public.desktop_tab_share set status = 'closed', switch_on = false, rev = rev + 1, updated_at = now()
    where host_id = actor and device_id = p_device_id and status <> 'closed'
      and not (tab_id = any (coalesce(p_live_tab_ids, '{}'::uuid[])));
end;
$$;

-- The snapshot gains each room's listed shared tabs and the server time. A host who left the
-- room drops out through the membership join. Older desktop clients ignore both fields.
create or replace function public.desktop_room_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to access shared rooms.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(room_data order by visited desc, room_id), '[]'::jsonb) into result
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
        'sharedTabs', coalesce((select jsonb_agg(public.desktop_tab_share_json(t) order by t.created_at, t.tab_id)
          from public.desktop_tab_share t
          join public.room_member host on host.room_id = t.room_id and host.member_id = t.host_id
          where t.room_id = r.id and t.status <> 'closed'), '[]'::jsonb)
      ) as room_data
    from public.room_member mine join public.room r on r.id = mine.room_id
    where mine.member_id = actor
  ) rooms;
  return jsonb_build_object('version', 1, 'userId', actor, 'rooms', result, 'now', now());
end;
$$;

revoke all on function public.desktop_tab_share_json(public.desktop_tab_share) from public, anon, authenticated;
revoke all on function public.desktop_tab_share_publish(jsonb, jsonb) from public, anon;
revoke all on function public.desktop_tab_share_head(uuid) from public, anon;
revoke all on function public.desktop_tab_share_pull(uuid, bigint, integer, integer, integer, integer) from public, anon;
revoke all on function public.desktop_tab_share_reconcile(text, uuid[]) from public, anon;
grant execute on function public.desktop_tab_share_publish(jsonb, jsonb) to authenticated;
grant execute on function public.desktop_tab_share_head(uuid) to authenticated;
grant execute on function public.desktop_tab_share_pull(uuid, bigint, integer, integer, integer, integer) to authenticated;
grant execute on function public.desktop_tab_share_reconcile(text, uuid[]) to authenticated;
notify pgrst, 'reload schema';
commit;
