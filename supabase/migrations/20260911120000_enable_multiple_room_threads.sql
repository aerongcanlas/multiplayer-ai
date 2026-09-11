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

-- NOT VALID preserves historical messages whose run_id predates fencing while
-- enforcing the fence on every insert/update performed after this cutover.
alter table public.ai_message
    add constraint ai_message_new_writes_require_run_id
    check (run_id is not null) not valid;

drop index public.ai_thread_one_active_per_room;
