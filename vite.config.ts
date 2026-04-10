import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      exclude: ["**/*.test.ts", "**/*.spec.ts", "dist/**"],
      include: ["apps/**/*.ts", "packages/**/*.ts"],
      reporter: ["text", "lcov"],
    },
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
