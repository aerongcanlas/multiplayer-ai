-- U8 coordinated cutover. Apply only after old AI/thread mutations are paused
-- and all old requests are drained. These guards make stale room-only writers
-- fail closed before the single-active-thread index is removed.

create or replace function public._ai_require_explicit_thread_identity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
    if new.creation_id is null then
        raise exception using
            errcode = '23502',
            message = 'explicit thread creation identity is required';
    end if;
    return new;
end;
$$;

revoke execute on function public._ai_require_explicit_thread_identity()
    from public, anon, authenticated;
grant execute on function public._ai_require_explicit_thread_identity()
    to service_role;

drop trigger if exists ai_thread_require_explicit_identity
    on public.ai_thread;
create trigger ai_thread_require_explicit_identity
before insert on public.ai_thread
for each row execute function public._ai_require_explicit_thread_identity();

create or replace function public._ai_require_fenced_thread_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
    if current_setting('app.ai_thread_mutation', true) is distinct from 'fenced'
       and (
           new.room_id is distinct from old.room_id
           or new.retired_at is distinct from old.retired_at
           or new.run_status is distinct from old.run_status
           or new.run_by is distinct from old.run_by
           or new.current_run_id is distinct from old.current_run_id
           or new.title is distinct from old.title
           or new.title_source is distinct from old.title_source
           or new.creation_id is distinct from old.creation_id
       ) then
        raise exception using
            errcode = '55000',
            message = 'thread mutations require a fenced service operation';
    end if;
    return new;
end;
$$;

revoke execute on function public._ai_require_fenced_thread_mutation()
    from public, anon, authenticated;
grant execute on function public._ai_require_fenced_thread_mutation()
    to service_role;

drop trigger if exists ai_thread_require_fenced_mutation
    on public.ai_thread;
create trigger ai_thread_require_fenced_mutation
before update on public.ai_thread
for each row execute function public._ai_require_fenced_thread_mutation();

-- NOT VALID preserves historical messages whose run_id predates fencing while
-- enforcing the fence on every insert/update performed after this cutover.
alter table public.ai_message
    add constraint ai_message_new_writes_require_run_id
    check (run_id is not null) not valid;

drop index public.ai_thread_one_active_per_room;
