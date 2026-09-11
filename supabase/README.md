# Room-thread database rollout

The multi-thread schema is additive until the final cutover migration. Do not
run `20260911120000_enable_multiple_room_threads.sql` while the previous
room-only application or any old worker can still mutate AI threads.

## Production rollout

1. Take a restorable database backup and record `ai_thread` and `ai_message`
   counts plus hashes of thread/message identity, authorship and content.
2. Pause AI/thread mutations at ingress. Room member chat may remain available.
3. Drain every old AI request. The old route maximum is 300 seconds; confirm
   there are no live requests or running rows before continuing.
4. Apply the additive ownership migration, if it is not already present, then
   apply the coordinated cutover migration. The cutover rejects thread inserts
   without `creation_id` and message writes without a fenced `run_id` before it
   removes `ai_thread_one_active_per_room`.
5. Deploy only the explicit-thread application and workers from the same
   release. Never run an old unfenced worker beside this release.
6. Verify member/nonmember access, service-only function privileges, two
   unarchived threads in one room, parallel runs on different threads, stale
   token rejection, archive/restore and retained legacy history.
7. Recompute the recorded counts and integrity hashes. Re-enable mutations only
   when they match and all application checks pass. Otherwise keep the feature
   unavailable and follow the compatible rollback below.

The following read-only checks are suitable for the release record:

```sql
select count(*) from public.ai_thread;
select count(*) from public.ai_message;

select md5(string_agg(
    concat_ws('|', id, room_id, created_at, retired_at), E'\n'
    order by id
)) as thread_identity_hash
from public.ai_thread;

select md5(string_agg(
    concat_ws('|', id, thread_id, seq, role, parts, metadata, author_id), E'\n'
    order by id
)) as message_integrity_hash
from public.ai_message;

select routine_name, grantee
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name like '%ai_thread%'
order by routine_name, grantee;
```

## Compatible rollback

Roll back to an application release that understands explicit thread IDs,
multiple unarchived threads and fenced ownership. Keep the migrated schema and
the fail-closed old-writer guards in place. This rollback does not discard or
archive user work.

Do not restore the former unique index or deploy the single-active-thread
application after any room has multiple unarchived threads. Check the
precondition without changing data:

```sql
select room_id, count(*)
from public.ai_thread
where retired_at is null
group by room_id
having count(*) > 1;
```

A pre-cutover schema restore is permissible only when this query returns no
rows, the backup/integrity comparison is verified, no post-cutover thread or
message must be retained, and an operator explicitly authorizes restoration.
Never delete or archive user work merely to make the old unique index fit.

## Local rehearsal

Use a disposable Supabase project. The guarded integration suite refuses
partial credentials, `NODE_ENV=production`, and non-local targets unless they
are explicitly marked disposable; it also refuses a configured application
Supabase URL. Seed current and retired legacy histories before applying the
cutover, then compare IDs, sequences, authors, content, counts and hashes after
migration and after the compatible application rollback rehearsal.
