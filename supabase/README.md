# Room-thread database rollout

## Desktop API and local schema types

The monorepo also contains `20260914120000_desktop_room_api.sql`. Apply it after
the September 11 migrations. The baseline already creates
`desktop_prompt_suggestion`; the new migration adds the desktop snapshot/command
RPCs, suggestion index and authenticated-only API permissions. It preserves the
web thread ownership guards. Existing deployments must reconcile their migration
history before applying it; never replay the baseline on an existing database.

Run `pnpm db:types` to regenerate `packages/db/src/generated/database.types.ts`
from the canonical migration chain using an in-memory PGlite database and
Supabase's pinned `@supabase/postgrest-typegen` generator. It needs neither Docker
nor remote credentials. The fixture stubs only platform auth/roles; application
tables and functions come directly from migrations. Generated output covers the
`public` application schema. `pnpm test` checks that the generated file is current.

See [shared-room setup](../docs/shared-rooms.md) for the desktop's public
configuration and GitHub OAuth loopback redirect.

## Web thread cutover

The multi-thread schema is additive until the final cutover migration. Do not
run `20260911120000_enable_multiple_room_threads.sql` while the previous
room-only application or any old worker can still mutate AI threads.

## Production rollout

1. Choose and record two immutable commits: `ROOM_THREADS_RELEASE_SHA` for the
   release being deployed and `ROOM_THREADS_ROLLBACK_SHA` for the immediately
   preceding release that already understands explicit thread IDs and fenced
   ownership. A commit from before the thread work is not a compatible rollback.
2. Reconcile migration history before applying DDL. The baseline file describes
   the schema that existed before migrations were adopted; it must be registered,
   not replayed, on an existing production database:

    ```sh
    pnpm --filter @multiplayer-ai/web exec supabase migration list --linked
    pnpm --filter @multiplayer-ai/web exec supabase migration repair 20260911093541 --status applied --linked
    pnpm --filter @multiplayer-ai/web exec supabase migration list --linked
    pnpm --filter @multiplayer-ai/web exec supabase db push --linked --dry-run
    ```

    Stop if the first list does not match the catalog represented by the baseline,
    if repair would hide a partially applied migration, or if the dry run proposes
    replaying `20260911093541_baseline_existing_schema.sql`.

3. Take a restorable database backup, record its identifier and tested restore
   target, and agree on RPO/RTO for the release. Record `ai_thread` and `ai_message`
   counts plus hashes of thread/message identity, authorship and content.
4. Pause AI/thread mutations at ingress with the deployment platform's route or
   maintenance control. Record the control/event ID and verify a POST to
   `/api/runs` is rejected while room member chat remains available.
5. Drain every old AI request and worker. Wait at least the old route maximum of
   300 seconds after ingress closes, confirm the platform reports zero active
   `/api/runs` requests, and confirm the database query below returns zero rows.
6. Apply the additive ownership migration, if it is not already present, then
   apply the coordinated cutover migration. The cutover rejects thread inserts
   without `creation_id`, incompatible direct thread updates, and message writes
   without a fenced `run_id` before it removes
   `ai_thread_one_active_per_room`. Abort on any lock timeout or statement error;
   keep ingress closed and restore from the recorded backup if catalog state is
   not understood.
7. Deploy exactly `ROOM_THREADS_RELEASE_SHA` for the application and workers.
   Never run an old unfenced worker beside this release.
8. Verify member/nonmember access, service-only function privileges, two
   unarchived threads in one room, parallel runs on different threads, stale
   token rejection, archive/restore and retained legacy history.
9. Recompute the recorded counts and integrity hashes. Re-enable mutations only
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
  and (routine_name like '%ai_thread%' or routine_name = '_ai_assert_member')
order by routine_name, grantee;

select count(*) as live_runs
from public.ai_thread
where run_status = 'running' or current_run_id is not null;

select tgname, tgrelid::regclass
from pg_trigger
where not tgisinternal
  and tgname in (
    'ai_thread_require_explicit_identity',
    'ai_thread_require_fenced_mutation'
  );
```

## Compatible rollback

Roll back to the recorded `ROOM_THREADS_ROLLBACK_SHA`, which must understand explicit thread IDs,
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
