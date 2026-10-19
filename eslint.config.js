import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  // Duck touches Workbench only through `WorkbenchPort` (assistant plan → Separable,
  // not separate): under src/assistant, only the local port may import the stores
  // or panels.
  {
    files: ["src/assistant/**/*.{ts,tsx}"],
    ignores: ["src/assistant/port.local.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)(state|panels)(/|$)",
              message:
                "Duck reaches the app only through WorkbenchPort (src/assistant/port.ts); add what you need there and implement it in port.local.ts.",
            },
          ],
        },
      ],
    },
  },
);
