import test from "node:test";
import assert from "node:assert/strict";
import { discover } from "./discovery";

type Routes = Record<string, unknown | ((body: unknown) => unknown)>;

/** A fetch that answers from routes keyed `GET url` or `POST url model`; anything else is down. */
function server(routes: Routes): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const key =
      init?.method === "POST" ? `POST ${url} ${body.model}` : `GET ${url}`;
    if (!(key in routes)) throw new Error("connection refused");
    const value = routes[key];
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (value === "malformed") throw new SyntaxError("Unexpected token");
        return typeof value === "function" ? value(body) : value;
      },
    } as Response;
  }) as typeof fetch;
}

const OLLAMA = "http://127.0.0.1:11434";
const LMSTUDIO = "http://127.0.0.1:1234";
const ollamaRoutes = (
  models: Record<string, Record<string, unknown>>,
  loaded: unknown[] = [],
): Routes => ({
  [`GET ${OLLAMA}/api/tags`]: {
    models: Object.keys(models).map((name) => ({ name })),
  },
  [`GET ${OLLAMA}/api/ps`]: { models: loaded },
  ...Object.fromEntries(
    Object.entries(models).map(([name, shown]) => [
      `POST ${OLLAMA}/api/show ${name}`,
      shown,
    ]),
  ),
});

test("Ollama offers only its tool-capable models (AE1)", async () => {
  const found = await discover(
    {},
    server(
      ollamaRoutes({
        "qwen3-coder:30b": {
          capabilities: ["completion", "tools"],
          parameters: "num_ctx 65536\nstop <|im_end|>",
        },
        "nomic-embed-text": { capabilities: ["embedding"] },
      }),
    ),
  );
  const ollama = found.servers.find((item) => item.id === "ollama")!;
  assert.equal(ollama.running, true);
  assert.deepEqual(ollama.models, [
    { id: "qwen3-coder:30b", name: "qwen3-coder:30b", context: 65_536 },
  ]);
  assert.deepEqual(found.providers, [
    {
      id: "ollama",
      name: "Ollama",
      baseURL: "http://127.0.0.1:11434/v1",
      models: [
        { id: "qwen3-coder:30b", name: "qwen3-coder:30b", context: 65_536 },
      ],
    },
  ]);
});

test("a model with no num_ctx that is not loaded has an unknown context and a warning", async () => {
  const found = await discover(
    {},
    server(
      ollamaRoutes(
        {
          "qwen3-coder:480b": {
            capabilities: ["tools"],
            model_info: { "qwen3moe.context_length": 262_144 },
          },
          "gemma3:12b": { capabilities: ["tools"] },
        },
        [{ name: "gemma3:12b", context_length: 8_192 }],
      ),
    ),
  );
  const [big, gemma] = found.servers[0]!.models;
  // The trained maximum is not what the server serves.
  assert.equal(big!.context, undefined);
  assert.match(big!.warning!, /unknown.*32k.*OLLAMA_CONTEXT_LENGTH/);
  // A loaded model reports the context it runs with.
  assert.equal(gemma!.context, 8_192);
  assert.match(gemma!.warning!, /8,192/);
  assert.equal("context" in found.providers[0]!.models[0]!, false);
});

test("Ollama down and LM Studio up yields LM Studio's tool models only", async () => {
  const found = await discover(
    {},
    server({
      [`GET ${LMSTUDIO}/api/v0/models`]: {
        data: [
          {
            id: "qwen/qwen3-coder-30b",
            type: "llm",
            capabilities: ["tool_use"],
            loaded_context_length: 40_960,
          },
          { id: "google/gemma-3-12b", type: "llm", capabilities: [] },
          { id: "mistral-small", type: "llm" },
          { id: "text-embedding-nomic", type: "embeddings" },
        ],
      },
    }),
  );
  assert.deepEqual(
    found.servers.map((item) => [item.id, item.running]),
    [
      ["ollama", false],
      ["lmstudio", true],
    ],
  );
  const models = found.servers[1]!.models;
  assert.deepEqual(
    models.map((model) => [model.id, model.context, model.unverified]),
    [
      ["qwen/qwen3-coder-30b", 40_960, undefined],
      // No capabilities field: kept, but marked unverified.
      ["mistral-small", undefined, true],
    ],
  );
  assert.deepEqual(
    found.providers.map((item) => item.baseURL),
    ["http://127.0.0.1:1234/v1"],
  );
});

test("no server running yields nothing within the timeout", async () => {
  const hanging = (() => new Promise(() => {})) as unknown as typeof fetch;
  const started = Date.now();
  const found = await discover({}, hanging, 100);
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(found.providers, []);
  assert.ok(
    found.servers.every((item) => !item.running && !item.models.length),
  );
});

test("a server answering malformed JSON reads as down", async () => {
  const found = await discover(
    {},
    server({
      [`GET ${OLLAMA}/api/tags`]: "malformed",
      [`GET ${LMSTUDIO}/api/v0/models`]: "malformed",
    }),
  );
  assert.ok(found.servers.every((item) => !item.running));
});

test("OLLAMA_HOST on another machine is noted, and only loopback is probed", async () => {
  const urls: string[] = [];
  const recording = (async (url: string) => {
    urls.push(url);
    throw new Error("down");
  }) as unknown as typeof fetch;
  const found = await discover(
    { OLLAMA_HOST: "http://10.0.0.5:11434" },
    recording,
  );
  assert.ok(urls.every((url) => url.startsWith("http://127.0.0.1:")));
  assert.match(found.servers[0]!.note!, /10\.0\.0\.5.*not supported yet/);
  const local = await discover({ OLLAMA_HOST: "127.0.0.1:11434" }, recording);
  assert.equal(local.servers[0]!.note, undefined);
});
