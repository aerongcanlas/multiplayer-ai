-- Spectator Mission Control: a read-along host also publishes its sub-agent cards as entries of
-- kind 'agent', and the tab's plan, running sub-agent count, and whether its harness reports
-- sub-agents on the record. Members pull cards apart from the lead transcript with a kinds filter.
begin;

alter table public.desktop_tab_share
  add column if not exists plan jsonb,
  add column if not exists running_agents integer,
  add column if not exists reports_agents boolean;

-- Whether a published sub-agent card is well formed. Coalesced by the caller, so a mistyped
-- field fails instead of yielding NULL.
create or replace function public.desktop_tab_share_agent_valid(card jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(card) = 'object'
    and not exists (select 1 from jsonb_object_keys(card) k
      where k <> all (array['key', 'parentKey', 'name', 'type', 'status', 'background', 'startedAt', 'endedAt',
        'toolUses', 'latestTool', 'joinedMidRun', 'turnId']))
    and jsonb_typeof(card->'key') = 'string' and length(card->>'key') between 1 and 200
    and (not card ? 'parentKey'
      or (jsonb_typeof(card->'parentKey') = 'string' and length(card->>'parentKey') between 1 and 200))
    and (not card ? 'name' or (jsonb_typeof(card->'name') = 'string' and length(card->>'name') <= 200))
    and (not card ? 'type' or (jsonb_typeof(card->'type') = 'string' and length(card->>'type') <= 200))
    and card->>'status' in ('running', 'completed', 'failed', 'stopped', 'interrupted')
    and jsonb_typeof(card->'background') = 'boolean'
    and jsonb_typeof(card->'startedAt') = 'string' and length(card->>'startedAt') <= 64
    and (not card ? 'endedAt' or (jsonb_typeof(card->'endedAt') = 'string' and length(card->>'endedAt') <= 64))
    and jsonb_typeof(card->'toolUses') = 'number' and card->>'toolUses' ~ '^[0-9]{1,9}$'
    and (not card ? 'latestTool'
      or (jsonb_typeof(card->'latestTool') = 'string' and length(card->>'latestTool') <= 400))
    and (not card ? 'joinedMidRun' or jsonb_typeof(card->'joinedMidRun') = 'boolean')
    and (not card ? 'turnId' or (jsonb_typeof(card->'turnId') = 'string'
      and card->>'turnId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'));
$$;

-- Whether a published plan is well formed: at most 50 steps of 300 characters.
create or replace function public.desktop_tab_share_plan_valid(plan jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(plan) = 'object'
    and octet_length(plan::text) <= 65536
    and not exists (select 1 from jsonb_object_keys(plan) k where k <> all (array['explanation', 'steps']))
    and (not plan ? 'explanation'
      or (jsonb_typeof(plan->'explanation') = 'string' and length(plan->>'explanation') <= 1000))
    and jsonb_typeof(plan->'steps') = 'array' and jsonb_array_length(plan->'steps') <= 50
    and not exists (select 1 from jsonb_array_elements(plan->'steps') step
      where not coalesce(jsonb_typeof(step) = 'object'
        and (select count(*) from jsonb_object_keys(step)) = 2
        and jsonb_typeof(step->'text') = 'string' and length(step->>'text') <= 300
        and step->>'status' in ('pending', 'active', 'done'), false));
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
  -- A JSON null stores NULL; an absent field keeps the stored value.
  tab_plan jsonb := nullif(p_tab->'plan', 'null'::jsonb);
  tab_running jsonb := nullif(p_tab->'runningAgents', 'null'::jsonb);
  tab_reports jsonb := nullif(p_tab->'reportsAgents', 'null'::jsonb);
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
    or not coalesce(jsonb_typeof(p_tab->'switchOn') = 'boolean', false)
    or (tab_plan is not null and not coalesce(public.desktop_tab_share_plan_valid(tab_plan), false))
    or (tab_running is not null
      and not coalesce(jsonb_typeof(tab_running) = 'number' and tab_running #>> '{}' ~ '^[0-9]{1,6}$', false))
    or (tab_reports is not null and not coalesce(jsonb_typeof(tab_reports) = 'boolean', false)) then
    raise exception 'The shared tab record is invalid.' using errcode = '22023';
  end if;
  if jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) > 200 then
    raise exception 'Publish at most 200 entries at a time.' using errcode = '22023';
  end if;
  for entry in select value from jsonb_array_elements(entries) loop
    if jsonb_typeof(entry) <> 'object'
      or exists (select 1 from jsonb_object_keys(entry) k
        where k <> all (array['seq', 'kind', 'share', 'state', 'outcome', 'notice', 'summary', 'text', 'detail',
          'version', 'agent']))
      or not coalesce(jsonb_typeof(entry->'seq') = 'number' and entry->>'seq' ~ '^[1-9][0-9]{0,8}$', false)
      or not coalesce(jsonb_typeof(entry->'version') = 'number' and entry->>'version' ~ '^[1-9][0-9]{0,8}$', false)
      or not coalesce(entry->>'kind' in ('user', 'assistant', 'plan', 'tool', 'approval', 'notice', 'error', 'turn',
        'agent'), false)
      or not coalesce(entry->>'share' in ('full', 'summary'), false)
      or not coalesce(jsonb_typeof(entry->'summary') = 'string' and length(entry->>'summary') <= 400, false)
      or (entry ? 'state' and not coalesce(entry->>'state' in ('pending', 'accepted', 'declined', 'answered', 'cancelled'), false))
      or (entry ? 'outcome' and not coalesce(entry->>'outcome' in ('completed', 'stopped', 'failed', 'interrupted'), false))
      or (entry ? 'notice' and not coalesce(jsonb_typeof(entry->'notice') = 'string' and entry->>'notice' ~ '^[a-z_]{1,40}$', false))
      or (entry ? 'text' and not coalesce(jsonb_typeof(entry->'text') = 'string' and length(entry->>'text') <= 200000, false))
      or (entry ? 'detail' and not coalesce(entry->>'kind' = 'plan' and jsonb_typeof(entry->'detail') = 'string'
        and octet_length(entry->>'detail') <= 65536, false))
      -- A card entry carries exactly one card, and no other kind carries one.
      or (entry->>'kind' = 'agent') is distinct from (entry ? 'agent')
      or (entry ? 'agent' and not coalesce(public.desktop_tab_share_agent_valid(entry->'agent'), false)) then
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
    status = p_tab->>'status', switch_on = (p_tab->>'switchOn')::boolean,
    -- A host omits these once read-along is off, so the record keeps what it last shared.
    plan = case when p_tab ? 'plan' then tab_plan else plan end,
    running_agents = case when p_tab ? 'runningAgents' then (tab_running #>> '{}')::integer else running_agents end,
    reports_agents = case when p_tab ? 'reportsAgents' then (tab_reports #>> '{}')::boolean else reports_agents end,
    rev = next_rev, updated_at = now()
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

-- The caller's own watermark: the newest entry, and as seeds every approval still stored as
-- pending and every sub-agent card still stored as running.
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
      from public.desktop_tab_share_entry e where e.tab_id = p_tab_id
        and (e.state = 'pending' or (e.kind = 'agent' and e.body->'agent'->>'status' = 'running'))), '[]'::jsonb));
end;
$$;

-- The pull gains a kinds filter. The old signature is dropped so a call without the new
-- argument resolves to this one function.
drop function if exists public.desktop_tab_share_pull(uuid, bigint, integer, integer, integer, integer);

-- Delta mode (after_rev given): rows past the (rev, seq) cursor in cursor order. History mode:
-- the newest rows below before_seq. A page stops at the byte budget and returns next when rows
-- remain. A kinds list keeps only entries of those kinds.
create or replace function public.desktop_tab_share_pull(p_tab_id uuid, p_after_rev bigint, p_after_seq integer,
  p_before_seq integer, p_limit integer, p_byte_budget integer, p_kinds text[] default null)
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
  if coalesce(cardinality(p_kinds), 0) > 20 then
    raise exception 'Too many entry kinds.' using errcode = '22023';
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
      and (p_kinds is null or e.kind = any (p_kinds))
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
  -- The pull's record adds the plan fields; the room snapshot's list keeps its shape. All three
  -- are null when the host's app predates sub-agent sharing.
  return jsonb_build_object('record', public.desktop_tab_share_json(shared) || jsonb_build_object(
      'plan', shared.plan, 'runningAgents', shared.running_agents, 'reportsAgents', shared.reports_agents),
    'entries', result, 'next', next_cursor, 'now', now());
end;
$$;

revoke all on function public.desktop_tab_share_agent_valid(jsonb) from public, anon, authenticated;
revoke all on function public.desktop_tab_share_plan_valid(jsonb) from public, anon, authenticated;
revoke all on function public.desktop_tab_share_publish(jsonb, jsonb) from public, anon;
revoke all on function public.desktop_tab_share_head(uuid) from public, anon;
revoke all on function public.desktop_tab_share_pull(uuid, bigint, integer, integer, integer, integer, text[]) from public, anon;
grant execute on function public.desktop_tab_share_publish(jsonb, jsonb) to authenticated;
grant execute on function public.desktop_tab_share_head(uuid) to authenticated;
grant execute on function public.desktop_tab_share_pull(uuid, bigint, integer, integer, integer, integer, text[]) to authenticated;
notify pgrst, 'reload schema';
commit;
