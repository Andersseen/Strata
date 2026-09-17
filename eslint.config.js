import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { flatConfigs as importX } from "eslint-plugin-import-x";
import promise from "eslint-plugin-promise";
import globals from "globals";
import { config, configs as tsConfigs } from "typescript-eslint";

export default config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "pnpm-lock.yaml",
      // Fixture source for a fully external Strata consumer (SPEC-001):
      // compiled by its own isolated tsc/Vite install, never by this repo's
      // tsconfigs, so it is intentionally outside this repo's lint project.
      "tests/consumer/fixture/**",
    ],
  },
  js.configs.recommended,
  ...tsConfigs.recommendedTypeChecked,
  importX.recommended,
  importX.typescript,
  promise.configs["flat/recommended"],
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "import-x/no-unresolved": "off",
      "import-x/no-duplicates": "error",
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    files: ["**/*.config.{js,ts,mjs,cjs}"],
    ...tsConfigs.disableTypeChecked,
  },
  {
    // Plain-JS consumer-qualification runner (SPEC-001): no tsconfig covers
    // it on purpose, since it orchestrates an isolated external install.
    files: ["tools/consumer/**/*.mjs"],
    ...tsConfigs.disableTypeChecked,
  },
  eslintConfigPrettier,
);
