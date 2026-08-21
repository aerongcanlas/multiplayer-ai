# @multiplayer-ai/orchestration

Agent run orchestration: lead/scout personas, tool loop, event stream, run lifecycle.

## Layout

```
src/
  agents/     lead + scout personas (instructions, delegation, tool wiring)
  run/        run lifecycle — start/resume/cancel, ports (interfaces), in-memory store
  tools/      filesystem + delegate tools exposed to agents
  config/     PROFILE — one balanced effort profile
  testing/    scripted mock LanguageModel for tests/demo
  demo.ts     runnable proof of the wiring, no API keys/DB/UI required
  index.ts    public barrel export
```