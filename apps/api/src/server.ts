import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { ZodError } from "zod";
import { ApiError, registerRooms } from "./rooms.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: string;
  }
}

export function buildServer(
  config: { supabaseUrl: string; publishableKey: string; databaseUrl: string },
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
  }),
) {
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: { redact: ["req.headers.authorization"] },
  });
  const auth = createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }),
    },
  });
  pool.on("error", () => app.log.error("An idle database connection failed."));
  app.addHook("onClose", async () => pool.end());
  app.decorateRequest("actor", "");
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token)
      throw new ApiError(
        401,
        "unauthorized",
        "Sign in to access shared rooms.",
      );
    const { data, error } = await auth.auth.getUser(token);
    if (error && (!error.status || error.status >= 500))
      throw new ApiError(
        503,
        "unavailable",
        "Sign-in verification is unavailable. Try again.",
      );
    if (error || !data.user)
      throw new ApiError(
        401,
        "unauthorized",
        "Your session expired. Sign in again.",
      );
    request.actor = data.user.id;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    if (error instanceof ZodError)
      return reply.code(400).send({
        code: "invalid_request",
        message: "Check the request fields and limits.",
      });
    const failure = error as { code?: string; statusCode?: number };
    if (["42P01", "42703"].includes(failure.code ?? ""))
      return reply.code(503).send({
        code: "setup_required",
        message: "Shared rooms need the current database migrations.",
      });
    if (
      failure.statusCode &&
      failure.statusCode >= 400 &&
      failure.statusCode < 500
    )
      return reply
        .code(failure.statusCode)
        .send({ code: "invalid_request", message: "Invalid HTTP request." });
    // PostgreSQL errors can contain SQL and private message text. Log only the code.
    request.log.error({ code: failure.code }, "Shared-room request failed.");
    return reply.code(503).send({
      code: "unavailable",
      message: "Shared rooms are unavailable. Refresh before retrying.",
    });
  });
  registerRooms(app, pool);
  return app;
}
