// ESLint flat config (ESLint 9+). Minimal: @eslint/js recommended + typescript-eslint recommended.
// Tuned to silence false positives in existing code rather than mass-refactor (AGENTS.md: Surgical Changes).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/**", "research/**", "openspec/**", "agent-docs/**", "docs/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // Tolerate the existing codebase. Re-enable individually in follow-up PRs.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/ban-ts-comment": ["warn", { "ts-ignore": "allow-with-description", "ts-expect-error": "allow-with-description" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-control-regex": "off",
      // Pre-existing across the codebase; not in this change's scope.
      "prefer-const": "warn",
      "no-useless-assignment": "off",
    },
  },
];
