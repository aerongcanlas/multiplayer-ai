# Multiplayer AI

## Quick Start

pnpm i
pnpm run dev

## Folder Structure

The project has two runnable apps and several shared packages:

```text
apps/
  web/            Next.js website and server endpoints
  worker/         Long-running AI jobs

packages/
  domain/         Shared product rules and types
  db/             Database tables and queries
  providers/      OpenAI, E2B, and other service connections
  config/         Environment settings and validation
  test-support/   Shared test data and helpers

docs/             Project plans and technical decisions
scripts/          Development and validation utilities
```

Apps may import shared packages. Shared packages must never import from apps.
