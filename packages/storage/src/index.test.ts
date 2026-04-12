import { describe, expect, it } from "vitest";

import { CURRENT_DATABASE_VERSION, MIGRATIONS, storageBootstrap } from "./index.ts";

describe("storage bootstrap", () => {
  it("declares SQLite with versioned migrations", () => {
    expect(storageBootstrap).toEqual({
      engine: "sqlite",
      migrationStrategy: "versioned",
    });
  });

  it("exposes the checked-in migration set", () => {
    expect(CURRENT_DATABASE_VERSION).toBe(260411100000);
    expect(MIGRATIONS).toHaveLength(3);
  });
});
