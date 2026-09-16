import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const fromRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: fromRoot("src/main/index.ts"),
          supervisor: fromRoot("src/supervisor/entry.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: fromRoot("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: fromRoot("src/renderer"),
    resolve: { alias: { "@": fromRoot("src/renderer") } },
    plugins: [react(), tailwindcss()],
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    build: { rollupOptions: { input: fromRoot("src/renderer/index.html") } },
  },
});
