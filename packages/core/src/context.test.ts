import { describe, expect, it, vi } from "vitest";

import { createConfig } from "./config.ts";
import { createContext, type IDb } from "./context.ts";

function createDbDouble(): IDb {
  return {
    close: vi.fn(),
    exec: vi.fn(),
    inTransaction: false,
    many: vi.fn(() => []),
    one: vi.fn(() => null),
    run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    transaction: vi.fn((fn) => fn(createDbDouble())),
    value: vi.fn(() => null),
  };
}

describe("createContext", () => {
  it("binds a config object and db implementation into the shared app context", () => {
    const config = createConfig({
      dataDirectory: "/tmp/smithly",
    });
    const db = createDbDouble();
    const context = createContext(config, db);

    expect(context.config).toBe(config);
    expect(context.db).toBe(db);
  });
});
