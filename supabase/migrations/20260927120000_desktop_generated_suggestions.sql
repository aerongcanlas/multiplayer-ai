-- Persist context-agent output while deriving identity and source attribution in Postgres.
begin;

create or replace function public.desktop_save_generated_suggestions(
  p_room_id uuid, p_message_ids uuid[], p_prompts text[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  source_rows jsonb;
  value text;
begin
  if actor is null then
    raise exception 'Sign in to save suggestions.' using errcode = '42501';
  end if;
  perform 1 from public.room_member where room_id = p_room_id and member_id = actor for share;
  if not found then
    raise exception 'You are no longer a member of this room.' using errcode = '42501';
  end if;
  if p_message_ids is null or cardinality(p_message_ids) not between 1 and 100
    or cardinality(p_message_ids) <> (select count(distinct id) from unnest(p_message_ids) id) then
    raise exception 'Select 1 to 100 distinct messages.' using errcode = '22023';
  end if;
  if p_prompts is null or cardinality(p_prompts) not between 1 and 3 then
    raise exception 'Generate 1 to 3 prompts before saving.' using errcode = '22023';
  end if;
  -- Snapshot canonical messages once; callers cannot supply authors or source text.
  select jsonb_agg(jsonb_build_object(
      'id', m.id, 'authorId', m.author_id, 'authorName', p.name,
      'text', m.text, 'createdAt', m.created_at) order by m.created_at, m.id)
    into source_rows
    from public.message m join public.user_profile p on p.id = m.author_id
    where m.room_id = p_room_id and m.id = any(p_message_ids);
  if coalesce(jsonb_array_length(source_rows), 0) <> cardinality(p_message_ids) then
    raise exception 'A selected message does not belong to this room.' using errcode = '42501';
  end if;
  foreach value in array p_prompts loop
    value := btrim(value);
    if value is null or length(value) not between 1 and 2000 then
      raise exception 'Generated prompts must contain 1 to 2,000 characters.' using errcode = '22023';
    end if;
    insert into public.desktop_prompt_suggestion(room_id, author_id, prompt, source_message_ids, sources)
      values(p_room_id, actor, value, p_message_ids, source_rows);
  end loop;
  return jsonb_build_object('snapshot', public.desktop_room_snapshot(), 'roomId', p_room_id);
end;
$$;

revoke all on function public.desktop_save_generated_suggestions(uuid, uuid[], text[]) from public, anon;
grant execute on function public.desktop_save_generated_suggestions(uuid, uuid[], text[]) to authenticated;
notify pgrst, 'reload schema';
commit;
