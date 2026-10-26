import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // `server-only` throws outside a React Server environment; tests run plain Node.
      "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "convex", include: ["convex/**/*.test.ts"], environment: "edge-runtime", server: { deps: { inline: ["convex-test"] } } },
      },
      {
        extends: true,
        test: { name: "lib", include: ["tests/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
