import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "out/**",
      "release/**",
      "output/**",
      "src/supervisor/harnesses/codex/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "node:*",
            "electron",
            "next/*",
            "@supabase/*",
            "**/main/*",
            "**/supervisor/*",
            "**/preload/*",
          ],
        },
      ],
    },
  },
  // Renderer unit tests run under node:test but may still not reach main, preload, or Electron.
  {
    files: ["src/renderer/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "electron",
            "next/*",
            "@supabase/*",
            "**/main/*",
            "**/supervisor/*",
            "**/preload/*",
          ],
        },
      ],
    },
  },
);
