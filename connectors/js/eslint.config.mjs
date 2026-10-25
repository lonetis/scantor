// ESLint for the TypeScript/JavaScript connector (`just lint`): the recommended JavaScript and TypeScript rules
// over the sources, the tests and the entry scripts, as in tests/eslint.config.mjs.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const nodeGlobals = Object.fromEntries(
  [
    ...["process", "console", "Buffer", "URL", "URLSearchParams", "fetch", "performance", "structuredClone"],
    ...["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "queueMicrotask"],
    ...["AbortController", "AbortSignal", "TextEncoder", "TextDecoder"],
  ].map((name) => [name, "readonly"]),
);

export default defineConfig(
  { ignores: ["node_modules/", "dist/", "check-tools/node_modules/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: nodeGlobals },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The tests walk untyped JSON documents (describe output, schemas, fixtures) by property.
    files: ["test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
