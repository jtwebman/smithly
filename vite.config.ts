import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      exclude: ["**/*.test.ts", "**/*.spec.ts", "dist/**"],
      include: ["apps/**/*.ts", "packages/**/*.ts"],
      reporter: ["text", "lcov"],
    },
    env: {
      SMITHLY_TEST_MODE: "1",
    },
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
