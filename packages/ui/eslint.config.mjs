import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import { builtinModules } from "node:module";

export default tseslint.config(
  { ignores: [".turbo/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.browser } },
  {
    files: ["src/**/*.{ts,tsx}", "tests/fixture/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules.filter((name) => !name.startsWith("node:")),
          patterns: [
            "node:*",
            "electron",
            "electron/*",
            "next",
            "next/*",
            "@supabase/*",
            "@multiplayer-ai/db",
            "@multiplayer-ai/db/*",
            "@multiplayer-ai/providers",
            "@multiplayer-ai/providers/*",
            "@multiplayer-ai/orchestration",
            "@multiplayer-ai/orchestration/*",
            "@/*",
            "**/apps/**",
          ],
        },
      ],
      "no-restricted-globals": ["error", "process", "Buffer", "require"],
    },
  },
  {
    files: ["*.mjs", "tests/*.{mjs,ts}"],
    languageOptions: { globals: globals.node },
  },
);
