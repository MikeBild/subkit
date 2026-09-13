import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "docs/**",
      ".claude/**",
      "assets/cockpit/**",
      "apps/engine/assets/embeddings/**",
      "apps/engine/src/http/cockpit-embedded.ts",
      "apps/engine/src/db/migrations/embedded.ts",
      "apps/engine/eval/out/**",
      "packages/cli-core/src/engine-api/openapi.d.ts",
      "apps/cockpit/src/api/schema.d.ts",
      "vendor/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    plugins: { "simple-import-sort": simpleImportSort },
    languageOptions: { globals: { ...globals.node, ...globals.browser, Bun: "readonly" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "@typescript-eslint/no-require-imports": "off",
      "no-template-curly-in-string": "warn",
      "no-cond-assign": ["error", "always"],
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-invalid-void-type": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-restricted-imports": ["error", { patterns: ["../**/_internal/*"] }],
    },
  },
  {
    files: ["apps/cockpit/**/*.tsx", "packages/chat-ui/**/*.tsx"],
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      "jsx-a11y/prefer-tag-over-role": "warn",
    },
  },
  {
    files: ["apps/cockpit/src/components/ui/**/*.tsx"],
    rules: {
      "jsx-a11y/interactive-supports-focus": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/prefer-tag-over-role": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
