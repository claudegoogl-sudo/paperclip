import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded-Postgres cleanup hooks (cluster stop) exceed the 10s default on loaded hosts.
    hookTimeout: 60_000,
  },
});
