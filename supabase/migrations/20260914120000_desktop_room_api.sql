-- Additive desktop API for the existing room/member/message schema.
-- No service-role key is required by a desktop client. Existing web policies are unchanged.
begin;

-- The canonical September 11 baseline already creates this table.
alter table public.desktop_prompt_suggestion enable row level security;
revoke all on public.desktop_prompt_suggestion from anon, authenticated;
create index if not exists desktop_prompt_suggestion_room_idx
  on public.desktop_prompt_suggestion(room_id, created_at desc);

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
          from (select * from public.desktop_prompt_suggestion where room_id = r.id order by created_at desc, id desc limit 50) s), '[]'::jsonb)
      ) as room_data
    from public.room_member mine join public.room r on r.id = mine.room_id
    where mine.member_id = actor
  ) rooms;
  return jsonb_build_object('version', 1, 'userId', actor, 'rooms', result);
end;
$$;

create or replace function public.desktop_room_command(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  operation text := p_command->>'type';
  target uuid;
  is_admin boolean;
  value text;
  new_id uuid;
  source_ids uuid[];
  source_rows jsonb;
  draft_prompt text;
  invite public.room_invite%rowtype;
  suggestion public.desktop_prompt_suggestion%rowtype;
begin
  if actor is null then raise exception 'Sign in to access shared rooms.' using errcode = '42501'; end if;
  if operation not in ('room.create', 'room.join', 'message.send', 'invite.create', 'suggestion.create', 'suggestion.edit') or operation is null then
    raise exception 'Unsupported shared-room operation.' using errcode = '22023';
  end if;
  -- Fill a missing profile for the authenticated actor only, using canonical auth metadata.
  insert into public.user_profile(id, name)
    select u.id, left(coalesce(nullif(u.raw_user_meta_data->>'preferred_username', ''),
      nullif(u.raw_user_meta_data->>'user_name', ''), nullif(u.raw_user_meta_data->>'name', ''), 'User'), 100)
    from auth.users u where u.id = actor
    on conflict(id) do nothing;

  if operation = 'room.create' then
    value := btrim(p_command->>'name');
    if value is null or length(value) not between 1 and 80 then raise exception 'Room names must contain 1 to 80 characters.'; end if;
    new_id := gen_random_uuid();
    insert into public.room(id, name, slug) values(new_id, value,
      coalesce(nullif(trim(both '-' from regexp_replace(lower(value), '[^a-z0-9]+', '-', 'g')), ''), 'room') || '-' || left(new_id::text, 8));
    insert into public.room_member(room_id, member_id, is_admin) values(new_id, actor, true);
    return jsonb_build_object('snapshot', public.desktop_room_snapshot(), 'roomId', new_id);
  end if;

  if operation = 'room.join' then
    value := p_command->>'tokenHash';
    if value is null or value !~ '^[a-f0-9]{64}$' then raise exception 'Invalid invitation.'; end if;
    select * into invite from public.room_invite where token_hash = value for update;
    if not found or invite.revoked_at is not null or invite.expires_at <= now() then raise exception 'Invitation is invalid, expired, or revoked.'; end if;
    if invite.accepted_at is not null then
      if invite.accepted_by = actor and exists(select 1 from public.room_member where room_id = invite.room_id and member_id = actor) then
        return jsonb_build_object('snapshot', public.desktop_room_snapshot(), 'roomId', invite.room_id);
      end if;
      raise exception 'This invitation has already been used.';
    end if;
    if invite.invited_email is not null and not exists(select 1 from auth.users where id = actor and lower(email) = lower(invite.invited_email)) then
      raise exception 'This invitation belongs to another email address.' using errcode = '42501';
    end if;
    insert into public.room_member(room_id, member_id, is_admin) values(invite.room_id, actor, false)
      on conflict(room_id, member_id) do nothing;
    update public.room_invite set accepted_at = now(), accepted_by = actor where id = invite.id;
    return jsonb_build_object('snapshot', public.desktop_room_snapshot(), 'roomId', invite.room_id);
  end if;

  target := (p_command->>'roomId')::uuid;
  select rm.is_admin into is_admin from public.room_member rm where rm.room_id = target and rm.member_id = actor;
  if not found then raise exception 'You are no longer a member of this room.' using errcode = '42501'; end if;

  if operation = 'message.send' then
    value := btrim(p_command->>'text');
    if value is null or length(value) not between 1 and 2000 then raise exception 'Messages must contain 1 to 2,000 characters.'; end if;
    insert into public.message(room_id, author_id, text) values(target, actor, value);
  elsif operation = 'invite.create' then
    if not is_admin then raise exception 'Only room admins can create invitations.' using errcode = '42501'; end if;
    value := p_command->>'tokenHash';
    if value is null or value !~ '^[a-f0-9]{64}$' then raise exception 'Invalid invitation.'; end if;
    insert into public.room_invite(room_id, created_by, token_hash, expires_at)
      values(target, actor, value, now() + interval '24 hours');
  elsif operation = 'suggestion.create' then
    select array_agg(v::uuid) into source_ids from jsonb_array_elements_text(p_command->'messageIds') v;
    if source_ids is null or cardinality(source_ids) not between 1 and 100
      or cardinality(source_ids) <> (select count(distinct v) from unnest(source_ids) v) then
      raise exception 'Select 1 to 100 distinct messages.';
    end if;
    if cardinality(source_ids) <> (select count(*) from public.message where room_id = target and id = any(source_ids)) then
      raise exception 'A selected message does not belong to this room.' using errcode = '42501';
    end if;
    select jsonb_agg(jsonb_build_object('id', m.id, 'authorId', m.author_id, 'authorName', p.name,
        'text', m.text, 'createdAt', m.created_at) order by m.created_at, m.id),
      string_agg(p.name || ': ' || m.text, E'\n\n' order by m.created_at, m.id)
      into source_rows, draft_prompt
      from public.message m join public.user_profile p on p.id = m.author_id where m.room_id = target and m.id = any(source_ids);
    draft_prompt := E'Consider this selected room feedback:\n\n' || draft_prompt || E'\n\nKeep conflicting advice visible and ask about missing requirements before making changes.';
    if length(draft_prompt) > 8000 then raise exception 'Select fewer messages so the suggestion fits within 8,000 characters.'; end if;
    insert into public.desktop_prompt_suggestion(room_id, author_id, prompt, source_message_ids, sources)
      values(target, actor, draft_prompt, source_ids, source_rows);
  elsif operation = 'suggestion.edit' then
    select * into suggestion from public.desktop_prompt_suggestion
      where id = (p_command->>'suggestionId')::uuid and room_id = target for update;
    if not found then raise exception 'Suggestion not found in this room.'; end if;
    if suggestion.author_id <> actor and not is_admin then raise exception 'Only the author or a room admin can edit this suggestion.' using errcode = '42501'; end if;
    if (p_command->>'expectedRevision')::integer is distinct from suggestion.revision then raise exception 'This suggestion changed. Refresh before editing.'; end if;
    value := btrim(p_command->>'prompt');
    if value is null or length(value) not between 1 and 8000 then raise exception 'Prompts must contain 1 to 8,000 characters.'; end if;
    update public.desktop_prompt_suggestion set prompt = value, revision = revision + 1, updated_at = now() where id = suggestion.id;
  end if;
  return jsonb_build_object('snapshot', public.desktop_room_snapshot(), 'roomId', target);
end;
$$;

revoke all on function public.desktop_room_snapshot() from public, anon;
revoke all on function public.desktop_room_command(jsonb) from public, anon;
grant execute on function public.desktop_room_snapshot() to authenticated;
grant execute on function public.desktop_room_command(jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
