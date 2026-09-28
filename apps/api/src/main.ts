import { z } from "zod";
import { buildServer } from "./server.js";

const config = z
  .object({
    SUPABASE_URL: z.url(),
    SUPABASE_PUBLISHABLE_KEY: z.string().startsWith("sb_publishable_"),
    DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  })
  .parse(process.env);

const app = buildServer({
  supabaseUrl: config.SUPABASE_URL,
  publishableKey: config.SUPABASE_PUBLISHABLE_KEY,
  databaseUrl: config.DATABASE_URL,
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch {
  app.log.error(
    "Could not start the shared-room API. Check its host and port.",
  );
  await app.close();
  process.exitCode = 1;
}
