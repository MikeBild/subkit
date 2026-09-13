import json from "@eslint/json";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "docs/**",
      ".claude/**",
      "assets/cockpit/**",
      "apps/engine/assets/embeddings/**",
      "apps/engine/eval/out/**",
      "packages/cli-core/src/engine-api/**",
      "vendor/**",
    ],
  },
  {
    files: ["**/*.json"],
    language: "json/jsonc",
    plugins: { json },
    rules: json.configs.recommended.rules,
  },
];
