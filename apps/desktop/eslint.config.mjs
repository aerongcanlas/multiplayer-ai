import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["out/**", "release/**", "output/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
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
);
