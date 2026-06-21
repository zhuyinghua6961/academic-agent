import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "apps/**"],
    environment: "node",
    testTimeout: 60_000,
  },
});
