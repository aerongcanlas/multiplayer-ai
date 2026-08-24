# Multiplayer AI
multiplayer-ai-bay.vercel.app
## Quick Start

```powershell
pnpm install
pnpm dev
```

## Folder Structure

The project has two runnable apps and three shared runtime packages:

```text
apps/
  web/
    src/app/       Next.js routes, layouts, and route handlers
    src/features/  Product code grouped by auth, rooms, and AI
    src/components Shared app composition and UI primitives
    src/lib/       Framework and service adapters
  worker/          Long-running jobs and sandbox operations

packages/
  domain/          Runtime-neutral product schemas and contracts
  db/              Generated database types
  providers/       Server-only AI provider selection
```
