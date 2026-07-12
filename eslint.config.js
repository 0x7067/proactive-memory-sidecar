// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Fail-open code paths intentionally swallow errors in many places;
      // require the reason to be explicit rather than banning the pattern.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/restrict-template-expressions": "off",
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Tests intentionally probe malformed/edge-case inputs.
      "@typescript-eslint/no-explicit-any": "off",
      // node:test's `test()`/`describe()` return a Promise that the test
      // runner itself tracks; awaiting each top-level call is not the
      // idiomatic pattern and would just add noise.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
