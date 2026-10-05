-- OpenCode harness: a read-along host may now publish tabs running OpenCode alongside Codex and
-- Claude. The harness check on the shared tab record and the publish function's record check
-- both gain 'opencode'; everything else about publishing, masking, and access is unchanged.
begin;

alter table public.desktop_tab_share
  drop constraint if exists desktop_tab_share_harness_check,
  add constraint desktop_tab_share_harness_check check (harness in ('codex', 'claude', 'opencode'));

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
    or not coalesce(p_tab->>'harness' in ('codex', 'claude', 'opencode'), false)
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

revoke all on function public.desktop_tab_share_publish(jsonb, jsonb) from public, anon;
grant execute on function public.desktop_tab_share_publish(jsonb, jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
