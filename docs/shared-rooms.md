# Shared rooms

## Supabase setup

The desktop targets the Supabase project configured in `apps/desktop/config/supabase.json`, which contains its URL and **public publishable key**. Forks use that same backend unless this configuration is changed. Never add a service-role/secret key or copy the web application's `.env.local` into the desktop bundle.

1. Follow [the database rollout guide](../supabase/README.md), reconcile existing migration history, then apply `supabase/migrations/20260914120000_desktop_room_api.sql` after the September 11 migrations. The baseline already creates the suggestion table; this migration adds the authenticated room API, index and permissions. A fresh local database uses the complete migration chain.
2. In Authentication > URL Configuration, add `http://127.0.0.1:54329/**` to Redirect URLs. Keep the current Site URL and existing redirects. GitHub remains the existing sign-in provider.
3. Start the desktop with `pnpm dev:desktop`, then choose **Sign in with GitHub**. Complete sign-in in the system browser and return to the desktop.
4. Choose **New room** and **Shared with members**. As admin, choose **Invite** and share its code. Teammates choose **Join with invite** after signing in. Codes expire after 24 hours and admit one account.

Verify the migration and OAuth redirect configuration for the project you intend to use before signing in. The migration extends the existing web room schema; it does not create a complete database from scratch. Local tests do not apply the migration remotely.

## Ownership and synchronization

The Electron main process owns the Supabase SDK, PKCE verifier, loopback callback, session refresh, and room RPCs. Session persistence uses Electron safeStorage, with no plaintext fallback. The renderer receives only public account details, canonical room content, sync status, and explicit operation results. It has no Supabase client, credentials, external network transport, or generic IPC.

Every database command derives identity from `auth.uid()`. Room reads and writes require membership; creating invitations requires an admin; editing suggestions requires the author or an admin and the expected revision. Source messages and authors are reloaded from the database. Invitations are stored as SHA-256 hashes and accepted atomically. The desktop API preserves existing web RLS policies. Run `pnpm db:types` after schema changes to regenerate the shared types from local migrations.

The current transport polls canonical snapshots every four seconds, with coalesced reads, serialized mutations, and a 15-second request timeout. It loads the latest 200 messages and 50 suggestions per room; earlier records remain in the database. Offline shared writes are disabled; no message is silently queued or replayed. Refresh before retrying a request whose outcome is uncertain. Membership removal is reflected at the next successful refresh, and the server rejects further writes immediately. Signing out clears shared views immediately. A different account cannot see the previous account's private execution cache.

Shared chat and suggestion edits synchronize with members. Repository selection, execution history, lead summaries, and simulations stay on their host. Shared suggestions are room feedback (context version 0); each local execution records its exact suggestion revision and attributed sources. Using a suggestion fills the composer and never runs another member's computer. Signing out or losing room membership stops associated local runs.

## Local verification

`pnpm check` covers TypeScript, ESLint, supervisor and OAuth tests, a PostgreSQL migration/authorization test using embedded PGlite and the complete canonical migration chain, and production bundling. `pnpm --filter @multiplayer-ai/desktop test:shared` launches two Electron profiles against a loopback-only fake auth/PostgREST server backed by that database. It covers PKCE, room creation, admin invitations, joining, chat/suggestion sync, encrypted credentials, offline recovery, restart, revocation, sign-out, and account isolation. The existing `pnpm --filter @multiplayer-ai/desktop test:e2e` and `pnpm test:desktop:packaged` cover local execution and process boundaries.

The mock transport override is accepted only in an unpackaged app with `MP_E2E=1` and a `127.0.0.1` URL. Packaged builds always use the configured HTTPS project. Tests use new profiles without production sessions. No Supabase or Vercel API is used for validation. Real GitHub sign-in and live room operations must be exercised by the user after setup.

PKCE follows [Supabase's PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow) and [redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls).

### Historical standalone verification

On 2026-09-04 (America/Los_Angeles), all workspace type/lint checks passed, followed by 14 desktop unit tests and the embedded PostgreSQL authorization test. The final Windows package passed all 11 local workflow checkpoints. The two-profile shared-room workflow passed all eight checkpoints. Screenshots were inspected for message alignment, attribution, room header controls, and account status.

Reports and screenshots are retained locally under the ignored `output/` directory. These local checks do not establish that another project's live migration, OAuth configuration, or room operations work; verify those against the configured backend after setup.

## Web interoperability

Web and desktop share room membership and persisted human messages. Desktop polls canonical snapshots every four seconds; the current web chat listens for browser-originated broadcasts. Desktop sends are visible after reopening the web room, but seamless updates to an already-open web chat require a separate canonical refresh/event integration. Web AI threads and desktop local executions remain independent, and prompt suggestions currently use different contracts.
