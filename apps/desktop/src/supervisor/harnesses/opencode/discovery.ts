import type { LocalServer } from "../../../shared/tabs";
import { object, string } from "../json";
import type { LocalProvider } from "./config";

const OLLAMA = "http://127.0.0.1:11434";
const LMSTUDIO = "http://127.0.0.1:1234";
// Agentic use with tools needs at least this much context.
const MIN_CONTEXT = 32_768;
const LOOPBACK =
  /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?\/?$/i;

export interface Discovery {
  servers: LocalServer[];
  providers: LocalProvider[];
}

type Model = LocalServer["models"][number];

async function json(
  request: typeof fetch,
  url: string,
  signal: AbortSignal,
  body?: unknown,
) {
  const response = await request(url, {
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return object(await response.json());
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;

function warned(model: Model, advice: string): Model {
  if (model.context && model.context >= MIN_CONTEXT) return model;
  return {
    ...model,
    warning: `${model.context ? `Served with ${model.context.toLocaleString("en-US")} tokens of context` : "Served context is unknown"}; agentic use needs at least 32k. ${advice}`,
  };
}

async function ollama(request: typeof fetch, signal: AbortSignal) {
  const tags = await json(request, `${OLLAMA}/api/tags`, signal);
  const running = await json(request, `${OLLAMA}/api/ps`, signal).catch(
    () => ({}) as Record<string, unknown>,
  );
  const loaded = new Map(
    (Array.isArray(running.models) ? running.models : [])
      .map(object)
      .map((model) => [string(model.name), positive(model.context_length)]),
  );
  const listed = (Array.isArray(tags.models) ? tags.models : [])
    .map(object)
    .map((model) => string(model.name) || string(model.model))
    .filter(Boolean);
  const models = await Promise.all(
    listed.map(async (name): Promise<Model | null> => {
      const shown = await json(request, `${OLLAMA}/api/show`, signal, {
        model: name,
      }).catch(() => null);
      if (!shown) return null;
      const capabilities = Array.isArray(shown.capabilities)
        ? shown.capabilities
        : [];
      if (!capabilities.includes("tools")) return null;
      // The served context is num_ctx when the model sets it, else what the loaded model uses.
      const numCtx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(
        string(shown.parameters),
      )?.[1];
      const context = positive(Number(numCtx)) ?? loaded.get(name);
      return warned(
        { id: name, name, ...(context ? { context } : {}) },
        "Start Ollama with a larger OLLAMA_CONTEXT_LENGTH (https://docs.ollama.com/context-length).",
      );
    }),
  );
  return models.filter((model): model is Model => model !== null);
}

async function lmstudio(request: typeof fetch, signal: AbortSignal) {
  const list = await json(request, `${LMSTUDIO}/api/v0/models`, signal);
  return (Array.isArray(list.data) ? list.data : [])
    .map(object)
    .filter((model) => model.type === "llm")
    .flatMap((model): Model[] => {
      const id = string(model.id);
      if (!id) return [];
      const capabilities = model.capabilities;
      // A model without a capabilities field may still call tools; it is kept, unverified.
      if (Array.isArray(capabilities) && !capabilities.includes("tool_use"))
        return [];
      const context = positive(model.loaded_context_length);
      return [
        warned(
          {
            id,
            name: id,
            ...(context ? { context } : {}),
            ...(Array.isArray(capabilities) ? {} : { unverified: true }),
          },
          "Load the model in LM Studio with a context length of at least 32k.",
        ),
      ];
    });
}

/**
 * Finds tool-capable models on Ollama and LM Studio at 127.0.0.1. Both are probed at once with a
 * short timeout; a server that is down or answers badly reads as not running.
 */
export async function discover(
  env: Record<string, string>,
  request: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<Discovery> {
  const probe = async (
    find: typeof ollama,
  ): Promise<{ running: boolean; models: Model[] }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const models = await Promise.race([
        find(request, controller.signal),
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () =>
            reject(new Error("timeout")),
          ),
        ),
      ]);
      return { running: true, models };
    } catch {
      return { running: false, models: [] };
    } finally {
      clearTimeout(timer);
    }
  };
  const [fromOllama, fromLmstudio] = await Promise.all([
    probe(ollama),
    probe(lmstudio),
  ]);
  const remote = env.OLLAMA_HOST && !LOOPBACK.test(env.OLLAMA_HOST.trim());
  const servers: LocalServer[] = [
    {
      id: "ollama",
      label: "Ollama",
      ...fromOllama,
      ...(remote
        ? {
            note: `OLLAMA_HOST points to ${env.OLLAMA_HOST}; this app checks only 127.0.0.1. Model servers on other machines are not supported yet.`,
          }
        : {}),
    },
    { id: "lmstudio", label: "LM Studio", ...fromLmstudio },
  ];
  const providers: LocalProvider[] = servers
    .filter((server) => server.models.length)
    .map((server) => ({
      id: server.id,
      name: server.label,
      baseURL: `${server.id === "ollama" ? OLLAMA : LMSTUDIO}/v1`,
      models: server.models.map(({ id, name, context }) => ({
        id,
        name,
        ...(context ? { context } : {}),
      })),
    }));
  return { servers, providers };
}
