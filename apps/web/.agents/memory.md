# Web App Memory

Last verified: 2026-08-14

## Purpose

This web app is the UI for a multiplayer AI room where multiple humans share one AI context. `GroupChatPanel` handles private human discussion, `PromptVotePanel` handles prompt approval, and `AIActivityPanel` displays authoritative AI activity.

## Implemented Stack

- Next.js 16.3 App Router with React 19 and TypeScript 5.
- Tailwind CSS 4 with shadcn 4 and Base UI.
- `clsx`, `tailwind-merge`, and `cn()` handle conditional classes.
- Inter is the primary sans-serif font.
- pnpm 11 is the package manager; Turborepo manages the repository.

## Current Structure

- `GroupChatPanel` is the private human Backchannel UI.
- `PromptVotePanel` is the Prompt Ballot UI.
- `AIActivityPanel` is the authoritative AI Stage UI.
- `RoomListPanel` displays available rooms.
- `/` and `/rooms/[roomId]` currently assemble these panels into the room layout.

Shared primitives live in `src/components/ui`. Imports beginning with `@/` resolve from `src/`.

## Styling

- Global theme variables live in `src/app/globals.css`.
- `body` uses `bg-background text-foreground`.
- Current background token is `oklch(0.209 0 0)`.
- Current foreground token is `oklch(0.8234 0 0)`.
- Component hex colors use Tailwind syntax such as `bg-[#2B2B2B]` and `text-[#FFFFFF]`.

## Product Direction

These items are planned architecture, not confirmed as implemented:

- Approved prompts become immutable packages containing selected context and permissions.
- Prompt lifecycle: Draft, Voting, Queued, Executing, Review, then Accepted, Retry, or Branch.
- Planned supporting tools include Next.js Route Handlers, Zod, Supabase, Temporal, OpenAI Responses API, and E2B.
- Apps may import shared packages; shared packages must never import apps.

## Current State

- Most room panels contain placeholder content.
- No authentication, realtime collaboration, database access, or AI execution appears in `apps/web` yet.
- `TextEntryBubble` accepts `onSubmit` but does not currently invoke it.
- `ThemeProvider` exists but is not mounted in the root layout.
- README and page metadata still contain Create Next App defaults.

## Working Rules

- Read the matching Next.js 16 documentation in `node_modules/next/dist/docs/` before changing Next.js APIs.
- Do not remove the generated `.agents/AGENTS.md` Next.js rules.
- Prefer existing UI primitives and `cn()` over duplicating layout utilities.
- Run `pnpm lint` and `pnpm build` from `apps/web` after meaningful changes.
- Preserve unrelated working-tree changes.
